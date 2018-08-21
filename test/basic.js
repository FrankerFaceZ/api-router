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

describe('router basics', function() {
	describe('creation', function() {
		it('exists', function() {
			should.exist(Router);
			Router.should.be.a('function');
		})

		it('creates a new router', function() {
			const router = new Router();
			router.should.be.an.instanceof(Router);
		});

		it('creates a new router without new', function() {
			const router = Router();
			router.should.be.an.instanceOf(Router);
		});

		it('has middleware', function() {
			const router = Router();
			router.middleware.should.be.a('function');
			const middle = router.middleware();
			should.exist(middle);
			middle.should.be.a('function');
		})

		it('middleware has router', function() {
			const router = Router();
			const middle = router.middleware();
			should.exist(middle.router);
			middle.router.should.eql(router);
		})
	});

	describe('routing', function() {
		it('handles no routes', async function () {
			const {req} = setup();

			const res = await req().get('/').send();
			res.status.should.eql(404);
		});

		it('handles routes', async function() {
			const {router, req} = setup();

			router.get('/', SUCCESS);

			const res = await req().get('/').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
		});

		it('errors with invalid paths', function() {
			const {router} = setup();

			should.throw(() => router.get(false, () => {}));
			should.throw(() => router.get([false], () => {}));
			should.not.throw(() => router.get('/', () => {}));
			should.not.throw(() => router.get(['/'], () => {}));

			should.throw(() => router.register());
			should.throw(() => router.register(null, '/', {}, () => {}));
			should.throw(() => router.register('get', null, {}, () => {}));
			should.throw(() => router.register('get', '/', false, () => {}));
			should.throw(() => router.register([false], '/', {}, () => {}));
			should.throw(() => router.register('get', [null], {}, () => {}));
			should.throw(() => router.register('get', '/', {}, null));
			should.not.throw(() => router.register('get', '/', null, () => {}));
		});

		it('errors with invalid options', function() {
			const {router} = setup();

			should.throw(() => router.get('/', false, () => {}));
			should.throw(() => router.get('/', {}, 3));
			should.not.throw(() => router.get('/', {}, () => {}));
		})

		it('handles methods', async function() {
			const {router, req} = setup();

			router.post('/', SUCCESS);
			router.put('/', NO_SUCCESS);

			let res = await req().get('/').send();
			res.status.should.eql(405);

			res = await req().post('/').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
		});

		it("doesn't 405 when configured", async function() {
			const {router, req} = setup({
				handle405: false
			});

			router.get('/', SUCCESS);

			const res = await req().post('/').send();
			res.status.should.eql(404);
		})

		it('handles OPTIONS', async function() {
			const {router, req} = setup();

			router.post('/', SUCCESS);
			router.put('/', NO_SUCCESS);

			const res = await req().options('/').send();
			res.status.should.eql(204);
			res.headers.allow.should.contain('POST');
			res.headers.allow.should.contain('PUT');
			res.headers.allow.should.not.contain('GET');
		});

		it("doesn't handle OPTIONS when configured", async function() {
			const {router, req} = setup({
				handleOptions: false
			});

			router.get('/', SUCCESS);

			const res = await req().options('/').send();
			res.status.should.eql(405);
		});

		it('handles ALL', async function() {
			const {router, req} = setup();

			router.all('/', SUCCESS);

			for(const method of ['get','post','put','del','patch']) {
				const res = await req()[method]('/').send(); // eslint-disable-line
				res.status.should.eql(200);
				res.type.should.eql('application/json');
				res.body.success.should.eql(true);
			}
		});

		it('handles OPTIONS with ALL', async function() {
			const {router, req} = setup();

			router.all('/', () => {});

			const res = await req().options('/').send();
			res.status.should.eql(204);

			for(const method of ['GET','POST','DELETE','PUT','PATCH']) {
				res.headers.allow.should.contain(method);
			}
		})

		it('uses a prefix', async function() {
			const {router, req} = setup({prefix: '/test'});

			router.get('/', SUCCESS);

			let res = await req().get('/').send();
			res.status.should.eql(404);

			res = await req().get('/test/').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
		});

		it('supports url parameters', async function() {
			const {router, req} = setup();

			router.get('/:name', ctx => {
				ctx.body = {
					hello: ctx.params.name
				}
			});

			const res = await req().get('/world').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.hello.should.eql('world');
		});

		describe('supports nesting', function() {
			it('with a path', async function() {
				const {router, req} = setup(),
					r2 = new Router;

				r2.get('/', SUCCESS);

				router.nest('/test', r2);

				let res = await req().get('/').send();
				res.status.should.eql(404);

				res = await req().get('/test/').send();
				res.status.should.eql(200);
				res.type.should.eql('application/json');
				res.body.success.should.eql(true);
			});

			it('without a path', async function() {
				const {router, req} = setup(),
					r2 = new Router;

				r2.get('/', SUCCESS);

				router.nest(r2);

				const res = await req().get('/').send();
				res.status.should.eql(200);
				res.type.should.eql('application/json');
				res.body.success.should.eql(true);
			});

			it('requires a valid path', function() {
				const router = new Router,
					r2 = new Router;

				should.throw(() => {
					router.nest(true, r2);
				}, /path must be a string/);
			});

			it('requires a valid router', function() {
				const router = new Router;
				should.throw(() => {
					router.nest('/test', {});
				}, /router must be a Router/)
			});

			it('only nests once per path', function() {
				const router = new Router,
					r2 = new Router;

				router.nest('/', r2);
				router.nest('/', r2);

				router._nested['/'].length.should.eql(1);
			});

			it('using use()', async function() {
				const {router, req} = setup(),
					r2 = new Router;

				r2.get('/', SUCCESS);

				router.use('/test', r2);

				let res = await req().get('/').send();
				res.status.should.eql(404);

				res = await req().get('/test/').send();
				res.status.should.eql(200);
				res.type.should.eql('application/json');
				res.body.success.should.eql(true);
			});

			it('with several paths', async function() {
				const {router, req} = setup(),
					r2 = new Router;

				r2.get('/', SUCCESS);

				router.use(['/test', '/here'], r2);

				let res = await req().get('/').send();
				res.status.should.eql(404);

				res = await req().get('/test/').send();
				res.status.should.eql(200);
				res.type.should.eql('application/json');
				res.body.success.should.eql(true);

				res = await req().get('/here/').send();
				res.status.should.eql(200);
				res.type.should.eql('application/json');
				res.body.success.should.eql(true);
			});

			it('via middleware', async function() {
				const {router, req} = setup(),
					r2 = new Router;

				r2.get('/', SUCCESS);

				router.use(r2.middleware());

				const res = await req().get('/').send();
				res.status.should.eql(200);
				res.type.should.eql('application/json');
				res.body.success.should.eql(true);
			});

			it('updates parents', async function() {
				const {router, req} = setup(),
					r2 = new Router;

				router.nest(r2);

				r2.get('/', SUCCESS);

				const res = await req().get('/').send();
				res.status.should.eql(200);
				res.type.should.eql('application/json');
				res.body.success.should.eql(true);
			})
		});

		describe('named routes', function() {
			it('supports names', async function() {
				const {router, req} = setup();

				router.get('test', '/', SUCCESS);

				const res = await req().get('/').send();
				res.status.should.eql(200);
				res.type.should.eql('application/json');
				res.body.success.should.eql(true);
			});

			it('builds urls', async function() {
				const {router, req} = setup();

				router.get('test', '/this/is/test', SUCCESS);
				router.get('/', ctx => {
					ctx.body = {
						url: ctx.urlFor('test')
					}
				});

				const res = await req().get('/').send();
				res.status.should.eql(200);
				res.type.should.eql('application/json');
				res.body.url.should.eql('/this/is/test');
			});

			it('errors with invalid routes', async function() {
				const {router, app, req} = setup();
				app.silent = true;

				router.get('/', ctx => {
					ctx.urlFor('test');
				});

				const res = await req().get('/').send();
				res.status.should.eql(500);
			});

			it('builds nested urls', async function() {
				const {router, req} = setup();
				const r2 = Router({name: 'test'});
				const r3 = Router({name: 'foo'});

				router.use(r2);
				r2.get('here', '/this/is/test', SUCCESS);

				r2.use(r3);
				r3.get('bar', '/baz', SUCCESS);

				r2.get('/relative', ctx => {
					ctx.body = {
						url: ctx.urlFor('.here'),
						another: ctx.urlFor('.foo.bar'),
						absolute: ctx.urlFor('test.here')
					}
				});

				router.get('/', ctx => {
					ctx.body = {
						url: ctx.urlFor('test.here'),
						another: ctx.urlFor('.test.foo.bar')
					}
				});

				let res = await req().get('/').send();
				res.status.should.eql(200);
				res.type.should.eql('application/json');
				res.body.url.should.eql('/this/is/test');
				res.body.another.should.eql('/baz');

				res = await req().get('/relative').send();
				res.status.should.eql(200);
				res.type.should.eql('application/json');
				res.body.url.should.eql('/this/is/test');
				res.body.absolute.should.eql('/this/is/test');
				res.body.another.should.eql('/baz');
			});

			it('builds urls with queries', async function() {
				const {router, req} = setup();

				router.get('test', '/this/is/test', SUCCESS);
				router.get('/', ctx => {
					ctx.body = {
						url: ctx.urlFor('test', {success: 1})
					}
				});

				const res = await req().get('/').send();
				res.status.should.eql(200);
				res.type.should.eql('application/json');
				res.body.url.should.eql('/this/is/test?success=1');
			});
		})
	})
})
