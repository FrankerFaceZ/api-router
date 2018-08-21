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
		})
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
	})
})
