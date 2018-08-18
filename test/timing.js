const Koa = require('koa');
const createServer = require('http').createServer;
const Chai = require('chai');
const ChaiHTTP = require('chai-http');

const Router = require('../lib/router');

const should = Chai.should();
Chai.use(ChaiHTTP)

const setup = options => {
	const app = new Koa,
		router = new Router(options),
		server = createServer(app.callback())

	app.use(async (ctx, next) => {
		const timers = ctx.timers = new Set,
			running = new Set;

		ctx.startTimer = key => {
			timers.add(key);
			running.add(key);
		}

		ctx.stopTimer = key => {
			if ( ! running.has(key) )
				throw new Error('stopped a timer that is not running');

			running.delete(key);
		}

		try {
			await next();
		} catch(err) {
			err.headers = Object.assign({}, err.headers, {
				'Server-Timing': Array.from(timers).join(', ')
			});
			throw err;
		}

		ctx.set('Server-Timing', Array.from(timers).join(', '));
	});

	app.use(router.middleware());
	return {
		app,
		router,
		server,
		req: () => Chai.request(server)
	}
}


describe('timing', function() {
	it('routing uses timers when available', async function() {
		const {router, req} = setup();

		router.get('/', ctx => {
			ctx.body = {
				success: true
			}
		});

		const res = await req().get('/').send();
		should.exist(res.headers['server-timing']);
		res.headers['server-timing'].should.contain('routing');
	});

	it('routing uses timers without a matching route', async function() {
		const {req} = setup();

		const res = await req().get('/').send();
		should.exist(res.headers['server-timing']);
		res.headers['server-timing'].should.contain('routing');
	});

	it('routing uses timers for 405s', async function() {
		const {router, req} = setup();

		router.post('/', ctx => {
			ctx.body = {
				success: true
			}
		});

		const res = await req().get('/').send();
		should.exist(res.headers['server-timing']);
		res.headers['server-timing'].should.contain('routing');
	})

	it('routing uses timers with 405 disabled', async function() {
		const {router, req} = setup({
			handle405: false
		});

		router.post('/', ctx => {
			ctx.body = {
				success: true
			}
		});

		const res = await req().get('/').send();
		should.exist(res.headers['server-timing']);
		res.headers['server-timing'].should.contain('routing');
	})
})
