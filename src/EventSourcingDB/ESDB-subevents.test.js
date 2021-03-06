// @ts-check
import {withESDB} from '../lib/_test-helpers'

test('work', async () => {
	const models = {
		foo: {
			preprocessor: ({event, dispatch, isMainEvent}) => {
				expect(isMainEvent).not.toBeUndefined()
				if (event.type === 'hi' || event.type === 'pre')
					dispatch('pre-' + event.type)
			},
			reducer: ({event, dispatch, isMainEvent}) => {
				expect(isMainEvent).not.toBeUndefined()
				let events
				if (event.type === 'hi' || event.type === 'red') {
					dispatch('red-' + event.type)
					events = [{type: 'red-out-' + event.type}]
				}
				return {set: [{id: event.type}], events}
			},
			deriver: ({event, dispatch, isMainEvent}) => {
				expect(isMainEvent).not.toBeUndefined()
				if (event.type === 'hi' || event.type === 'der')
					dispatch('der-' + event.type)
			},
		},
	}
	return withESDB(async eSDB => {
		const checker = async id =>
			// this way we see the desired value in the output
			expect((await eSDB.store.foo.get(id)) || false).toHaveProperty('id', id)
		const event = await eSDB.dispatch('hi')
		expect(event.events).toHaveLength(4)
		await checker('pre-hi')
		await checker('red-hi')
		await checker('red-out-hi')
		await checker('der-hi')
		expect((await eSDB.dispatch('pre')).events).toHaveLength(1)
		await checker('pre-pre')
		await eSDB.dispatch('red')
		await checker('red-red')
		await checker('red-out-red')
		await eSDB.dispatch('der')
		await checker('der-der')
	}, models)
})

test('depth first order', () => {
	const models = {
		foo: {
			reducer: ({event, dispatch}) => {
				if (event.type === 'hi') return {set: [{id: 'hi', all: ''}]}
				if (event.type === '3') dispatch('4')
			},
			deriver: async ({model, event, dispatch}) => {
				if (event.type === 'hi') {
					dispatch('1')
					dispatch('3')
				}
				if (event.type === '1') dispatch('2')
				if (event.type === '3') dispatch('5')
				const t = await model.get('hi')
				return model.set({id: 'hi', all: t.all + event.type})
			},
		},
	}
	return withESDB(async eSDB => {
		const spy = jest.fn(event => event.type)
		eSDB.on('result', spy)
		const event = await eSDB.dispatch('hi')
		expect(spy).toHaveBeenCalledTimes(1)
		expect(event.events).toHaveLength(2)
		expect(await eSDB.store.foo.get('hi')).toHaveProperty('all', 'hi12345')
	}, models)
})

test('no infinite recursion', () => {
	const models = {
		foo: {
			deriver: async ({event, dispatch}) => {
				if (event.type === 'hi') dispatch('hi')
			},
		},
	}
	return withESDB(async eSDB => {
		eSDB.__BE_QUIET = true
		const doNotCall = jest.fn()
		const event = await eSDB.dispatch('hi').then(doNotCall, e => e)
		expect(doNotCall).toHaveBeenCalledTimes(0)
		expect(event).toHaveProperty(
			'error._handle',
			expect.stringMatching(/(\.hi)+:.*deep/)
		)
	}, models)
})

test('replay clears subevents', () => {
	const models = {
		foo: {
			deriver: async ({event, dispatch}) => {
				if (event.type === 'hi') dispatch('ho')
			},
		},
	}
	return withESDB(async eSDB => {
		await eSDB.queue.set({v: 5, type: 'hi', events: [{type: 'deleteme'}]})
		const event = await eSDB.handledVersion(5)
		expect(event).toHaveProperty('events', [
			expect.objectContaining({type: 'ho'}),
		])
	}, models)
})
