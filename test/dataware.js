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

const NO_SUCCESS = ctx => {
	ctx.body = {
		success: false
	}
}

const SUCCESS = ctx => {
	ctx.body = {
		success: true
	}
};

const TEST_DATAWARE = data => ctx => {
	ctx.body = {
		success: true,
		data
	}
}


describe('dataware', function() {
	describe('basics', function() {
		it('does input checks', function() {
			const {router} = setup();

			should.throw(() => router.useData(null, TEST_DATAWARE));
			should.throw(() => router.useData('test', false));
			should.throw(() => router.useData('test', TEST_DATAWARE, null));
			should.throw(() => router.useData('test', false, TEST_DATAWARE));
			should.throw(() => router.useData('test', 1, null));
			should.not.throw(() => router.useData('test', TEST_DATAWARE));
			should.not.throw(() => router.useData('test', TEST_DATAWARE, () => {}));
			should.not.throw(() => router.useData('test', 3, TEST_DATAWARE));
		})

		it('uses dataware', async function() {
			const {router, req} = setup();

			router.useData('test', TEST_DATAWARE);

			router.get('/', {test: true}, NO_SUCCESS);

			const res = await req().get('/').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
		});

		it('does not use dataware', async function() {
			const {router, req} = setup();

			router.useData('test', TEST_DATAWARE);

			router.get('/no', NO_SUCCESS);
			router.get('/yes', {test: true}, NO_SUCCESS);

			let res = await req().get('/no').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(false);

			res = await req().get('/yes').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
		});

		it('runs with false-ish data', async function() {
			const {router, req} = setup();

			router.useData('test', TEST_DATAWARE);

			router.get('/', {test: false}, NO_SUCCESS);

			const res = await req().get('/').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
		});
	});

	describe('weird output', function() {
		it('allows dataware methods to return nothing', async function() {
			const {router, req} = setup();

			router.useData('test', () => null);

			router.get('/', {test: false}, SUCCESS);

			const res = await req().get('/').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
		});

		it('allows dataware methods to return an empty list', async function() {
			const {router, req} = setup();

			router.useData('test', () => []);

			router.get('/', {test: false}, SUCCESS);

			const res = await req().get('/').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
		});

		it('composes multiple return values from one dataware', async function() {
			const {router, req} = setup();

			router.useData('test', () => [
				(ctx, next) => {
					ctx.body = {
						one: true
					};
					return next();
				},
				null,
				(ctx, next) => {
					ctx.body.two = true;
					return next();
				}
			]);

			router.get('/', {test: false}, ctx => {
				ctx.body.three = true;
			});

			const res = await req().get('/').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.one.should.eql(true);
			res.body.two.should.eql(true);
			res.body.three.should.eql(true);
		})
	});

	describe('defaults', function() {
		it('runs with default data', async function() {
			const {router, req} = setup();

			router.useData('test', TEST_DATAWARE);
			router.defaultData('test', 42);

			router.get('/', NO_SUCCESS);

			const res = await req().get('/').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
			res.body.data.should.eql(42);
		});

		it('inherits default data', async function () {
			const {router, req} = setup();
			const r2 = new Router;

			router.useData('test', TEST_DATAWARE);
			router.defaultData('test', 42);

			router.use(r2);

			r2.get('/', NO_SUCCESS);

			const res = await req().get('/').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
			res.body.data.should.eql(42);
		});

		it('uses child default data', async function() {
			const {router, req} = setup();
			const r2 = new Router;

			router.useData('test', TEST_DATAWARE);
			router.defaultData('test', 40);
			router.use(r2);

			r2.defaultData('test', 42);
			r2.get('/', NO_SUCCESS);

			const res = await req().get('/').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
			res.body.data.should.eql(42);
		});

		it('runs entirely in child', async function() {
			const {router, req} = setup();
			const r2 = new Router;

			r2.useData('test', TEST_DATAWARE);
			r2.defaultData('test', 42);

			router.use(r2);

			r2.get('/', NO_SUCCESS);

			const res = await req().get('/').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
			res.body.data.should.eql(42);
		});
	});

	describe('nesting', function() {
		it('does input checks', function() {
			const {router} = setup();

			should.throw(() => router.setDataExclusive());
			should.throw(() => router.setDataExclusive(null, true));
			should.throw(() => router.setDataExclusive('test', 3));
			should.not.throw(() => router.setDataExclusive('test'));
			should.not.throw(() => router.setDataExclusive('test', false));
			should.not.throw(() => router.setDataExclusive('test', true));
		})

		it('inherits data-ware from parent routers', async function() {
			const {router, req} = setup();
			const r2 = new Router;

			router.useData('test', TEST_DATAWARE);
			router.use(r2);

			r2.get('/', {test: 42}, NO_SUCCESS);

			const res = await req().get('/').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
			res.body.data.should.eql(42);
		});

		it('does not inherit excluded data-ware from parent routers', async function() {
			const {router, req} = setup();
			const r2 = new Router;

			router.useData('test', TEST_DATAWARE);
			router.use(r2);

			r2.get('/', {test: 42}, NO_SUCCESS);
			r2.setDataExclusive('test');

			const res = await req().get('/').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(false);
			should.not.exist(res.body.data);
		});

		it('works from nested routers', async function() {
			const {router, req} = setup();
			const r2 = new Router;

			router.use(r2);
			r2.useData('test', TEST_DATAWARE);

			r2.get('/', {test: 42}, NO_SUCCESS);

			const res = await req().get('/').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
			res.body.data.should.eql(42);
		});

		it('only applies once with nested routers', async function() {
			const r1 = new Router;
			const r2 = new Router;
			const r3 = new Router;

			r1.useData('test', () => (ctx, next) => {
				ctx.data = (ctx.data || 0) + 1;
				return next();
			});

			r3.get('/', {test: true}, ctx => {
				ctx.body = {
					success: true,
					data: ctx.data
				}
			});

			r2.use(r3);
			r1.use(r2);

			const app = new Koa,
				server = createServer(app.callback()),
				req = () => Chai.request(server);

			app.use(r1.middleware());

			const res = await req().get('/').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
			res.body.data.should.eql(1);
		})
	});

	describe('sorting', function() {
		it('does input checks', function() {
			const {router} = setup();

			should.throw(() => router.sortData(null, 3));
			should.throw(() => router.sortData('test', null));
			should.not.throw(() => router.sortData('test', 0));
		});

		it('sorts dataware in the order they are defined', async function() {
			const {router, req} = setup();

			router.useData('one', TEST_DATAWARE);
			router.useData('two', TEST_DATAWARE);
			router.useData('three', TEST_DATAWARE);

			router.get('/12', {one: 1, two: 2}, NO_SUCCESS);
			router.get('/23', {two: 2, three: 3}, NO_SUCCESS);

			let res = await req().get('/12').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
			res.body.data.should.eql(1);

			res = await req().get('/23').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
			res.body.data.should.eql(2);
		})

		it('sorts dataware with overrides', async function() {
			const {router, req} = setup();

			router.useData('three', 1, TEST_DATAWARE);
			router.useData('two', TEST_DATAWARE);
			router.useData('one', TEST_DATAWARE);

			router.sortData('one', -1);

			router.get('/12', {one: 1, two: 2}, NO_SUCCESS);
			router.get('/23', {two: 2, three: 3}, NO_SUCCESS);

			let res = await req().get('/12').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
			res.body.data.should.eql(1);

			res = await req().get('/23').send();
			res.status.should.eql(200);
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
			res.body.data.should.eql(2);
		})

		it('allows dataware to override sorting', async function() {
			const {router, req} = setup();

			router.useData('one', TEST_DATAWARE);
			router.useData('two', data => {
				const fn = ctx => {
					ctx.body = {
						success: true,
						data
					}
				}

				fn.sort = -1;
				return fn;
			});

			router.get('/12', {one: 1, two: 2}, NO_SUCCESS);

			const res = await req().get('/12').send();
			res.status.should.eql(200)
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
			res.body.data.should.eql(2);
		})

		it('allows dataware to return multiple functions', async function() {
			const {router, req} = setup();

			router.useData('one', data => [
				(ctx, next) => next(),
				TEST_DATAWARE(data)
			]);

			router.get('/12', {one: 1}, NO_SUCCESS);

			const res = await req().get('/12').send();
			res.status.should.eql(200)
			res.type.should.eql('application/json');
			res.body.success.should.eql(true);
			res.body.data.should.eql(1);
		})
	})
})
