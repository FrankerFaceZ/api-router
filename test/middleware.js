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

	app.use(router.middleware());
	return {
		app,
		router,
		server,
		req: () => Chai.request(server)
	}
}

const SUCCESS = ctx => {
	ctx.body = {
		success: true
	}
}

const NO_SUCCESS = ctx => {
	ctx.body = {
		success: false
	}
}


describe('middleware', function() {
	describe('basics', function() {
		it('does input validation', function() {
			const {router} = setup();

			should.throw(() => router.use());
			should.throw(() => router.use(null, () => {}));
			should.throw(() => router.use('/test', false));
			should.throw(() => router.use(false));
			should.throw(() => router.use([false], () => {}));
			should.not.throw(() => router.use('/test', () => {}));
			should.not.throw(() => router.use(['/test', '/here'], () => {}, () => {}));
		})

		it('composes multiple functions', async function() {
			const {router, req} = setup();

			router.get('/',
				(ctx, next) => {
					ctx.body = {success: true};
					ctx.status = 500;
					return next();
				},
				ctx => { ctx.status = 200 }
			);

			const res = await req().get('/').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
		});

		it('errors if next is called multiple times', async function() {
			const {app, router, req} = setup();
			app.silent = true;

			router.get('/',
				async (ctx, next) => {
					await next();
					await next();
				},
				ctx => { ctx.status = 200 }
			);

			const res = await req().get('/').send();
			res.status.should.eql(500);
		});

		it('errors if an error happens in a handler', async function() {
			const {app, router, req} = setup();
			app.silent = true;

			router.get('/', ctx => {
				ctx.body = {DOES_NOT_EXIST} // eslint-disable-line
			});

			const res = await req().get('/').send();
			res.status.should.eql(500);
		});

		it('calls the external next at the top of the stack', async function() {
			const {app, router, req} = setup();

			app.use(SUCCESS);

			router.get('/', (ctx, next) => next());

			const res = await req().get('/').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
		});

		it('errors if middleware is not a function', function() {
			const {router} = setup();

			should.throw(() => router.get('/', false));
		})

		it('composes middleware with route callbacks', async function() {
			const {router, req} = setup();

			router.use((ctx, next) => {
				ctx.body = {success: true};
				ctx.status = 500;
				return next();
			});

			router.get('/', ctx => { ctx.status = 200 });

			const res = await req().get('/').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
		})
	});

	describe('routing', function() {
		it('supports paths', async function() {
			const {router, req} = setup();

			router.use('/', (ctx, next) => {
				ctx.body = {success: true};
				ctx.status = 500;
				return next();
			});

			router.get('/', ctx => { ctx.status = 200 });

			const res = await req().get('/').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
		});

		it('only applies middleware to matching routes', async function() {
			const {router, req} = setup();

			router.use('/yes', SUCCESS);

			router.get(['/yes', '/no'], NO_SUCCESS);

			let res = await req().get('/no').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(false);

			res = await req().get('/yes').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
		});

		it('applies middleware to routes with dynamic bits', async function() {
			const {router, req} = setup();

			router.use('/yes', SUCCESS);

			router.get('/:maybe', NO_SUCCESS);

			let res = await req().get('/no').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(false);

			res = await req().get('/yes').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
		});

		it('applies middleware with a router prefix', async function() {
			const {router, req} = setup(),
				r2 = new Router({prefix: '/test'});

			router.use(r2);

			r2.use(SUCCESS);
			r2.get('/', NO_SUCCESS);

			const res = await req().get('/test/').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
		});

		it('uses middleware from parent routers', async function() {
			const {router, req} = setup(),
				r2 = new Router();

			router.use(r2);

			router.use(SUCCESS);
			r2.get('/', NO_SUCCESS);

			const res = await req().get('/').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
		})
	});

	describe('mounting', function() {
		it('does input validation', function() {
			const {router} = setup();

			should.throw(() => router.mount());
			should.throw(() => router.mount('/test'));
			should.throw(() => router.mount(null, SUCCESS));
			should.throw(() => router.mount('/test', 3));
			should.throw(() => router.mount(null, {}, SUCCESS));
			should.throw(() => router.mount('/test', false, SUCCESS));
			should.throw(() => router.mount('/test', {}, false));
			should.not.throw(() => router.mount('/test', SUCCESS));
			should.throw(() => router.mount('test', SUCCESS));
		});

		it('gets the right path', async function() {
			const {router, req} = setup();

			router.mount('/test', ctx => {
				ctx.body = {
					path: ctx.path
				}
			});

			const res = await req().get('/test/here').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.path.should.eql('/here');
		});

		it('does nothing if mount middleware is disabled', async function() {
			const {router, req} = setup({
				mountMiddleware: false
			});

			router.mount('/test', ctx => {
				ctx.body = {
					path: ctx.path
				}
			});

			const res = await req().get('/test/here').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.path.should.eql('/test/here');
		});

		it('accepts extra data', async function() {
			const {router, req} = setup();

			router.mount('/test', {some_data: true}, ctx => {
				ctx.body = {
					path: ctx.path,
					success: ctx.state.route.some_data
				}
			});

			const res = await req().get('/test/here').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.path.should.eql('/here');
			res.body.success.should.eql(true);
		})

		it('restores the path after an error', async function() {
			const {router, req} = setup();

			router.use(async (ctx, next) => {
				try {
					await next();
				} catch(err) { /* no-op */ }

				ctx.body = {
					path: ctx.path
				}
			});

			router.mount('/test', ctx => {
				ctx.body = DOES_NOT_EXIST // eslint-disable-line no-undef
			});

			const res = await req().get('/test/here').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.path.should.eql('/test/here');
		})
	})

	describe('params', function() {
		it('does input validation', function() {
			const {router} = setup();

			should.throw(() => router.param());
			should.throw(() => router.param('test', null));
			should.throw(() => router.param(null, SUCCESS));
			should.throw(() => router.param('test', 3));
			should.not.throw(() => router.param('test', SUCCESS));
		});

		it('supports params', async function() {
			const {router, req} = setup();

			router.param('test', (val, ctx) => {
				ctx.body = {test: val}
			});

			router.get('/:test', () => {});

			const res = await req().get('/here').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.test.should.eql('here');
		});

		it('only runs param middlewhere when they are present', async function() {
			const {app, router, req} = setup();
			app.silent = true;

			router.param('test', (val, ctx) => {
				ctx.throw(500);
			});

			router.get('/yes/:test', ctx => { ctx.body = {success: true} });
			router.get('/no/:other', ctx => { ctx.body = {success: true} });

			let res = await req().get('/no/test').send();
			res.status.should.eql(200);

			res = await req().get('/yes/test').send();
			res.status.should.eql(500);
		});

		it('works from parent routers', async function() {
			const {router, req} = setup();
			const r2 = Router();

			router.use(r2);
			router.param('test', (val, ctx) => {
				ctx.body = {
					success: true
				}
			});

			r2.get('/:test', NO_SUCCESS);

			const res = await req().get('/test').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
		});

		it('works from nested routers', async function() {
			const {router, req} = setup();
			const r2 = Router();

			router.use(r2);
			r2.param('test', (val, ctx) => {
				ctx.body = {
					success: true
				}
			});

			r2.get('/:test', NO_SUCCESS);

			const res = await req().get('/test').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
		})
	});
})
