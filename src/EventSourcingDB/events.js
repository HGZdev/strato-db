import {withESDB} from '../lib/_test-helpers'

test('applyEvent', () => {
	return withESDB(async eSDB => {
		await eSDB.db.withTransaction(() =>
			eSDB._applyEvent(
				{
					v: 50,
					type: 'foo',
					result: {
						count: {set: [{id: 'count', total: 1, byType: {foo: 1}}]},
					},
				},
				true
			)
		)
		expect(await eSDB.store.count.get('count')).toEqual({
			id: 'count',
			total: 1,
			byType: {foo: 1},
		})
		expect(await eSDB.getVersion()).toBe(50)
	})
})

test('dispatch', async () => {
	return withESDB(async eSDB => {
		const event1P = eSDB.dispatch('whattup', 'indeed', 42)
		const event2P = eSDB.dispatch('dude', {woah: true}, 55)
		expect(await event2P).toEqual({
			v: 2,
			type: 'dude',
			ts: 55,
			data: {woah: true},
			result: {
				count: {set: [{id: 'count', total: 2, byType: {whattup: 1, dude: 1}}]},
			},
		})
		expect(await event1P).toEqual({
			v: 1,
			type: 'whattup',
			ts: 42,
			data: 'indeed',
			result: {
				count: {set: [{id: 'count', total: 1, byType: {whattup: 1}}]},
			},
		})
	})
})

test('derivers', async () => {
	return withESDB(async eSDB => {
		await eSDB.dispatch('bar')
		expect(await eSDB.store.deriver.searchOne()).toEqual({
			desc: 'Total: 1, seen types: bar',
			id: 'descCount',
		})
	})
})

test('preprocessors', async () => {
	return withESDB(
		async eSDB => {
			await expect(
				eSDB._preprocessor({type: 'pre type'})
			).resolves.toHaveProperty(
				'error._preprocess_meep',
				expect.stringContaining('type')
			)
			await expect(
				eSDB._preprocessor({type: 'pre version'})
			).resolves.toHaveProperty(
				'error._preprocess_meep',
				expect.stringContaining('version')
			)
			await expect(
				eSDB._preprocessor({type: 'bad event'})
			).resolves.toHaveProperty(
				'error._preprocess_meep',
				expect.stringContaining('Yeah, no.')
			)
			await eSDB.dispatch('create_thing', {foo: 2})
			expect(await eSDB.store.meep.searchOne()).toEqual({
				id: '5',
				foo: 2,
			})
		},
		{
			meep: {
				preprocessor: async ({event, model, store, dispatch}) => {
					if (!model) throw new Error('expecting my model')
					if (!store) throw new Error('expecting the store')
					if (!dispatch) throw new Error('expecting dispatch for subevents')
					if (event.type === 'create_thing') {
						event.type = 'set_thing'
						event.data.id = 5
						return event
					}
					if (event.type === 'pre type') {
						delete event.type
						return event
					}
					if (event.type === 'pre version') {
						event.v = 123
						return event
					}
					if (event.type === 'bad event') {
						return {error: 'Yeah, no.'}
					}
				},
				reducer: (model, event) => {
					if (event.type === 'set_thing') {
						return {set: [event.data]}
					}
					return false
				},
			},
		}
	)
})

test('preprocessor/reducer for ESModel', async () =>
	withESDB(
		async eSDB => {
			await eSDB.dispatch('set_thing', {foo: 2})
			expect(await eSDB.store.meep.searchOne()).toEqual({
				id: 1,
				foo: 2,
				ok: true,
			})
			await eSDB.rwStore.meep.set({id: 2})
			const event = await eSDB.queue.get(2)
			expect(event.data).toEqual([1, 2, {id: 2}])
			expect(event.result).toEqual({meep: {ins: [{id: 2}]}})
		},
		{
			meep: {
				columns: {id: {type: 'INTEGER'}},
				preprocessor: async ({event}) => {
					if (event.data && event.data.foo) event.data.ok = true
				},
				reducer: (model, event) => {
					if (event.type === 'set_thing') {
						return {set: [event.data]}
					}
					return false
				},
			},
		}
	))
