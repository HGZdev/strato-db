// @ts-check
/* eslint-disable no-console */
import path from 'path'
import debug from 'debug'
import {performance} from 'perf_hooks'
import {inspect} from 'util'
import sqlite3 from 'sqlite3'
import Statement from './Statement'
import {EventEmitter} from 'events'

const dbg = debug('strato-db/sqlite')
const dbgQ = dbg.extend('query')

const RETRY_COUNT = 3

const wait = ms => new Promise(r => setTimeout(r, ms))

const getDuration = ts =>
	(performance.now() - ts).toLocaleString(undefined, {maximumFractionDigits: 2})

const objToString = o => {
	const s = inspect(o, {compact: true, breakLength: Infinity})
	return s.length > 250 ? `${s.slice(0, 250)}… (${s.length}b)` : s
}

const quoteSqlId = s => `"${s.toString().replace(/"/g, '""')}"`

export const valToSql = v => {
	if (typeof v === 'boolean') return v ? '1' : '0'
	if (typeof v === 'number') return v.toString()
	if (v == null) return 'NULL'
	return `'${v.toString().replace(/'/g, "''")}'`
}

/**
 * sql provides templating for SQL.
 *
 * Example:
 *   `` db.all`select * from ${'foo'}ID where ${'t'}LIT = ${bar} AND json = ${obj}JSON` ``
 *
 * is converted to
 *   `db.all('select * from "foo" where t = ? and json = ?', [bar, JSON.stringify(obj)])`
 *
 * @param  {Array<string>} template - the template
 * @param  {...any} interpolations - the template interpolations
 * @returns {array} - [out, variables] for consumption by the call method
 */
export const sql = (...args) => {
	const strings = args[0]
	let out = strings[0]
	const vars = []
	for (let i = 1; i < strings.length; i++) {
		const val = args[i]
		let str = strings[i]

		const found = /^(ID|JSON|LIT)\b/.exec(str)
		const mod = found && found[0]
		str = mod ? str.slice(mod.length) : str

		if (mod === 'ID') {
			out += quoteSqlId(val)
		} else if (mod === 'LIT') {
			out += val
		} else {
			out += '?'
			vars.push(mod === 'JSON' ? JSON.stringify(val) : val)
		}
		out += str
	}
	return [out, vars]
}
sql.quoteId = quoteSqlId

let connId = 1

/**
 * SQLite is a wrapper around a single SQLite connection (via node-sqlite3).
 * It provides a Promise API, lazy opening, auto-cleaning prepared statements
 * and safe ``db.run`select * from foo where bar=${bar}` `` templating.
 * @extends EventEmitter
 */
class SQLite extends EventEmitter {
	/**
	 * @constructor
	 * @param  {object} options -
	 * @param  {string} [options.file] path to db file
	 * @param  {boolean} [options.readOnly] open read-only
	 * @param  {boolean} [options.verbose] verbose errors
	 * @param  {function} [options.onWillOpen] called before opening
	 * @param  {function} [options.onDidOpen] called after opened
	 * @param  {string} [options.name] name for debugging
	 * @param  {object} [options._sqlite] sqlite instance for child dbs
	 * @param  {object} [options._store={}] models registry for child dbs
	 * @param  {object} [options._statements={}] statements registry for child dbs
	 */
	constructor({
		file,
		readOnly,
		verbose,
		onWillOpen,
		onDidOpen,
		name,
		_sqlite,
		_store = {},
		_statements = {},
		...rest
	} = {}) {
		super()

		if (Object.keys(rest).length)
			throw new Error(`Unknown options ${Object.keys(rest).join(',')}`)
		this.file = file || ':memory:'
		this.name = `${name || path.basename(this.file, '.db')}|${connId++}`
		this.readOnly = readOnly
		this._isChild = !!_sqlite
		this._sqlite = _sqlite
		this.store = _store
		this.statements = _statements
		this.options = {onWillOpen, onDidOpen, verbose}
		this.dbP = new Promise(resolve => {
			this._resolveDbP = resolve
		})
	}

	static sql = sql

	sql = sql

	async _openDB() {
		const {
			file,
			readOnly,
			_isChild,
			options: {verbose, onWillOpen},
		} = this
		if (_isChild)
			throw new Error(
				`Child dbs cannot be opened. Perhaps you kept a prepared statement from a child db?`
			)

		if (onWillOpen) await onWillOpen()

		dbg(`${this.name} opening ${this.file}`)

		const _sqlite = await new Promise((resolve, reject) => {
			if (verbose) sqlite3.verbose()
			const mode = readOnly
				? sqlite3.OPEN_READONLY
				: sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE
			const db = new sqlite3.Database(file, mode, err => {
				if (err) reject(new Error(`${file}: ${err.message}`))
				else resolve(db)
			})
		})

		// Wait 15s for locks
		_sqlite.configure('busyTimeout', 15000)

		const childDb = new SQLite({
			file: this.file,
			readOnly: this.readOnly,
			name: this.name,
			_sqlite,
			_store: this.store,
		})

		// in dev mode, 50% of the time, return unordered selects in reverse order (chosen once per open)
		if (process.env.NODE_ENV === 'development' && Date.now() & 1)
			await childDb.exec('PRAGMA reverse_unordered_selects = ON')

		if (!this.readOnly) {
			// Journaling mode WAL
			if (this.file !== ':memory:') {
				await childDb.get('PRAGMA journal_mode')
				const {journal_mode: journalMode} = await childDb
					.get('PRAGMA journal_mode = wal')
					.catch(err => {
						if (!err.message.startsWith('SQLITE_BUSY')) throw err
					})
				if (journalMode !== 'wal') {
					console.error(
						`!!! WARNING: journal_mode is ${journalMode}, not WAL. Locking issues might occur!`
					)
				}
			}
			// Some sane settings
			await childDb.exec(`
					PRAGMA foreign_keys = ON;
					PRAGMA recursive_triggers = ON;
					PRAGMA journal_size_limit = 4000000
				`)
			this._optimizerToken = setInterval(
				() => this.exec(`PRAGMA optimize`),
				2 * 3600 * 1000
			)
			this._optimizerToken.unref()

			if (this.options.onDidOpen) await this.options.onDidOpen(childDb)
			await childDb.close()
		}

		this._sqlite = _sqlite

		dbg(`${this.name} ${file} opened`)

		return this
	}

	/**
	 * Force opening the database instead of doing it lazily on first access
	 * @returns {Promise<void>} - a promise for the DB being ready to use
	 */
	open() {
		const {_resolveDbP} = this
		if (_resolveDbP) {
			this._resolveDbP = null
			this._dbP = this._openDB().then(result => {
				_resolveDbP(result)
				this._dbP = null
				return result
			})
		}
		return this.dbP
	}

	/**
	 * Close the database connection, including the prepared statements
	 * @returns {Promise<void>} - a promise for the DB being closed
	 */
	async close() {
		dbg(`closing ${this.name}`)

		this.dbP = new Promise(resolve => {
			this._resolveDbP = resolve
		})
		const {_sqlite} = this
		this._sqlite = null

		// eslint-disable-next-line no-await-in-loop
		for (const stmt of Object.values(this.statements)) await stmt.finalize()

		// We only want to close our own statements, not the db
		if (this._isChild) return

		clearInterval(this._optimizerToken)
		if (this._dbP) await this._dbP
		if (_sqlite) await this._call('close', [], _sqlite, this.name)
	}

	async _hold(method) {
		if (dbgQ.enabled) dbgQ('_hold', this.name, method)
		await this.open()
		return this._sqlite
	}

	// eslint-disable-next-line max-params
	async _call(method, args, obj, name, returnThis, returnFn) {
		const isStmt = obj && obj.isStatement
		let _sqlite
		if (!obj) _sqlite = await this._hold(method)
		else if (isStmt) _sqlite = obj._stmt
		else _sqlite = obj
		if (!_sqlite)
			throw new Error(`${name}: sqlite or statement not initialized`)

		// Template strings
		if (!isStmt && Array.isArray(args[0])) {
			args = sql(...args)
			if (!args[1].length) args.pop()
		}

		const now = dbgQ.enabled ? performance.now() : undefined
		let fnResult
		const result = new Promise((resolve, reject) => {
			// We need to consume `this` from sqlite3 callback
			const cb = function(err, out) {
				if (err) reject(new Error(`${name}: sqlite3: ${err.message}`))
				else
					resolve(
						returnFn
							? fnResult
							: returnThis
							? {lastID: this.lastID, changes: this.changes}
							: out
					)
			}
			if (!_sqlite[method])
				return cb({message: `method ${method} not supported`})
			fnResult = _sqlite[method](...(args || []), cb)
		})
		if (dbgQ.enabled) {
			const what = `${name}.${method}`
			const q = isStmt ? `` : String(args[0]).replace(/\s+/g, ' ')
			const v = args
				? isStmt
					? objToString(args)
					: objToString(args[isStmt ? 0 : 1])
				: ''
			// eslint-disable-next-line promise/catch-or-return
			result.then(
				o => {
					if (returnFn) o = fnResult
					const d = getDuration(now)
					const out =
						method !== 'exec' && method !== 'prepare'
							? `-> ${objToString(o)}`
							: ''
					return dbgQ(`${what} ${q} ${v} ${d}ms ${out}`)
				},
				err => {
					const d = getDuration(now)
					dbgQ(`!!! FAILED ${err.message} ${what} ${q} ${v}${d}ms `)
				}
			)
		}
		return result
	}

	/**
	 * Return all rows for the given query
	 * @param {string} sql - the SQL statement to be executed
	 * @param {Array<*>} [vars] - the variables to be bound to the statement
	 * @returns {Promise<Array<object>>} - the results
	 */
	all(...args) {
		return this._call('all', args, this._sqlite, this.name)
	}

	/**
	 * Return the first row for the given query
	 * @param {string} sql - the SQL statement to be executed
	 * @param {Array<*>} [vars] - the variables to be bound to the statement
	 * @returns {Promise<(object|null)>} - the result or falsy if missing
	 */
	get(...args) {
		return this._call('get', args, this._sqlite, this.name)
	}

	/**
	 * Run the given query and return the metadata
	 * @param {string} sql - the SQL statement to be executed
	 * @param {Array<*>} [vars] - the variables to be bound to the statement
	 * @returns {Promise<object>} - an object with `lastID` and `changes`
	 */
	run(...args) {
		return this._call('run', args, this._sqlite, this.name, true)
	}

	/**
	 * Run the given query and return nothing. Slightly more efficient than {@link run}
	 * @param {string} sql - the SQL statement to be executed
	 * @param {Array<*>} [vars] - the variables to be bound to the statement
	 * @returns {Promise<void>} - a promise for execution completion
	 */
	async exec(...args) {
		await this._call('exec', args, this._sqlite, this.name)
	}

	/**
	 * Register an SQL statement for repeated running. This will store the SQL
	 * and will prepare the statement with SQLite whenever needed, as well as
	 * finalize it when closing the connection.
	 * @param {string} sql - the SQL statement to be executed
	 * @param {string} [name] - a short name to use in debug logs
	 * @returns {Statement} - the statement
	 */
	prepare(sql, name) {
		if (this.statements[sql]) return this.statements[sql]
		return new Statement(this, sql, name)
	}

	/**
	 * Run the given query and call the function on each item.
	 * Note that node-sqlite3 seems to just fetch all data in one go.
	 * @param {string} sql - the SQL statement to be executed
	 * @param {Array<*>} [vars] - the variables to be bound to the statement
	 * @param {function} cb(row) - the function to call on each row
	 * @returns {Promise<void>} - a promise for execution completion
	 */
	each(...args) {
		const lastIdx = args.length - 1
		if (typeof args[lastIdx] === 'function') {
			// err is always null, no reason to have it
			const onRow = args[lastIdx]
			args[lastIdx] = (_, row) => onRow(row)
		}
		return this._call('each', args, this._sqlite, this.name)
	}

	/**
	 * Returns the data_version, which increases when other connections write
	 * to the database.
	 * @returns {Promise<number>} - the data version
	 */
	async dataVersion() {
		if (!this._sqlite) await this._hold('dataVersion')
		if (!this._dataVSql)
			this._dataVSql = this.prepare('PRAGMA data_version', 'dataV')
		const {data_version: v} = await this._dataVSql.get()
		return v
	}

	/**
	 * Returns or sets the user_version, an arbitrary integer connected
	 * to the database.
	 * @param {number} [newV] - if given, sets the user version
	 * @returns {Promise<(number|void)>} - the user version or nothing when setting
	 */
	async userVersion(newV) {
		if (!this._sqlite) await this._hold('userVersion')
		// Can't prepare or use pragma with parameter
		if (newV)
			return this._call(
				'exec',
				[`PRAGMA user_version=${Number(newV)}`],
				this._sqlite,
				this.name
			)
		if (!this._userVSql)
			this._userVSql = this.prepare('PRAGMA user_version', 'userV')
		const {user_version: v} = await this._userVSql.get()
		return v
	}

	transactionP = Promise.resolve()

	/**
	 * Run a function in an immediate transaction. Within a connection, the invocations
	 * are serialized, and between connections it uses busy retry waiting. During a
	 * transaction, the database can still be read.
	 * @param {function} fn - the function to call. It doesn't get any parameters
	 * @returns {Promise<void>} - a promise for transaction completion.
	 * @throws - when the transaction fails or after too many retries
	 */
	async withTransaction(fn) {
		if (this.readOnly) throw new Error(`${this.name}: DB is readonly`)
		if (!this._sqlite) await this._hold('transaction')

		// Prevent overlapping transactions in this process
		const nextTransaction = () => this.__withTransaction(fn)

		this.transactionP = this.transactionP.then(nextTransaction, nextTransaction)
		return this.transactionP
	}

	async __withTransaction(fn, count = RETRY_COUNT) {
		try {
			await this.exec(`BEGIN IMMEDIATE`)
			this.emit('begin')
		} catch (error) {
			if (error.code === 'SQLITE_BUSY' && count) {
				// Transaction already running
				if (count === RETRY_COUNT) dbg('DB is busy, retrying')
				await wait(Math.random() * 1000 + 200)
				return this.__withTransaction(fn, count - 1)
			}
			throw error
		}
		let result
		try {
			result = await fn()
		} catch (error) {
			if (process.env.NODE_ENV !== 'test')
				console.error('transaction failure, rolling back', error)
			await this.exec(`ROLLBACK`)
			this.emit('rollback')
			this.emit('finally')
			throw error
		}
		await this.exec(`END`)
		this.emit('end')
		this.emit('finally')
		return result
	}
}

export default SQLite
