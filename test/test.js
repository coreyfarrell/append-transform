import fs from 'fs';
import test from 'ava';
import MockSystem from './_mock-module-system';
import appendTransform from '..';

// Transform that just appends some text
function append(message) {
	return code => code + ' ' + message;
}

test.beforeEach(t => {
	t.context = new MockSystem({
		'/foo.js': 'foo'
	});
});

test('installs a transform', t => {
	const system = t.context;
	system.appendTransform(append('a'));
	const module = system.load('/foo.js');

	t.is(module.code, 'foo a');
});

test('replacing an extension that just forwards through to `old` without calling compile', t => {
	const system = t.context;

	const old = system.extensions['.js'];
	system.extensions['.js'] = function (module, filename) {
		old(module, filename);
	};

	system.appendTransform(append('a'));
	system.installConventionalTransform(append('b'));
	system.installConventionalTransform(append('c'));

	const module = system.load('/foo.js');

	t.is(module.code, 'foo b c a');
});

test('immediately replaced by an extension that just forwards through to `old` without calling compile', t => {
	const system = t.context;

	system.appendTransform(append('a'));

	const old = system.extensions['.js'];
	system.extensions['.js'] = function (module, filename) {
		old(module, filename);
	};

	system.installConventionalTransform(append('b'));
	system.installConventionalTransform(append('c'));

	const module = system.load('/foo.js');

	t.is(module.code, 'foo b c a');
});

test('extension that just forwards through to `old` without calling compile the middle of a chain', t => {
	const system = t.context;
	system.appendTransform(append('a'));
	system.installConventionalTransform(append('b'));

	const old = system.extensions['.js'];
	system.extensions['.js'] = function (module, filename) {
		old(module, filename);
	};

	system.installConventionalTransform(append('c'));

	const module = system.load('/foo.js');

	t.is(module.code, 'foo b c a');
});

test('can install other than `.js` extensions', t => {
	const system = new MockSystem({
		'/foo.coffee': 'foo'
	});

	// No default extension exists for coffee - we need to add the first one manually.
	system.extensions['.coffee'] = function (module, filename) {
		let content = system.content[filename];
		content = filename + '(' + content + ')';
		module._compile(content, filename);
	};

	system.installConventionalTransform(append('a'), '.coffee');
	system.appendTransform(append('b'), '.coffee');
	system.installConventionalTransform(append('c'), '.coffee');

	const module = system.load('/foo.coffee');

	t.is(module.code, '/foo.coffee(foo) a c b');
});

test('installs a transform for a completely new file extension (handler added after)', t => {
	const system = new MockSystem({
		'/foo.es6': 'foo'
	});

	system.appendTransform(append('bar'), '.es6');

	system.extensions['.es6'] = function (module, filename) {
		const content = system.content[filename];
		module._compile(content + ' es6', filename);
	};

	const module = system.load('/foo.es6');

	t.is(module.code, 'foo es6 bar');
});

test('installs a transform for a completely new file extension (handler never added)', t => {
	appendTransform(append(' + " baz"'), '.bar');

	t.is(require('./fixture/foo.bar'), 'foo bar baz');
});

test('test actual require', t => {
	// eslint-disable-next-line node/no-deprecated-api
	require.extensions['.foo'] = function (module, filename) {
		module._compile(fs.readFileSync(filename, 'utf8'), filename);
	};

	appendTransform(code => code + ' + " bar"', '.foo');

	t.is(require('./fixture/foo.foo'), 'foo bar');
});

test('accommodates a future extension that adds, then reverts itself', t => {
	const system = t.context;

	system.appendTransform(append('always-last'));
	system.installConventionalTransform(append('b'));
	const rollback = system.extensions['.js'];
	system.installConventionalTransform(append('c'));
	const module = system.load('/foo.js');

	t.is(module.code, 'foo b c always-last');

	system.extensions['.js'] = rollback;
	delete system.cache['/foo.js'];
	const module2 = system.load('/foo.js');

	t.is(module2.code, 'foo b always-last');
});

test('handles nested requires', t => {
	const system = new MockSystem({
		'/foo.js': 'require("/bar.js");',
		'/bar.js': 'require("/baz.js");',
		'/baz.js': 'require("/foo.js");'
	});

	system.appendTransform(append('z'));
	system.installConventionalTransform(append('a'));
	system.appendTransform(append('x'));
	system.installConventionalTransform(append('b'));

	const foo = system.load('/foo.js');

	t.is(foo.code, 'require("/bar.js"); a b x z');
	t.is(foo.required['/bar.js'].code, 'require("/baz.js"); a b x z');
});

test('test ERR_REQUIRE_ESM suppression', t => {
	class ERR_REQUIRE_ESM extends Error {
	}
	ERR_REQUIRE_ESM.prototype.code = 'ERR_REQUIRE_ESM';

	const fooFile = require.resolve('./fixture/foo-esm.foo');
	const system = new MockSystem({
		[fooFile]: 'mock file gets ignored by default .js handler'
	});

	system.extensions['.foo'] = function () {
		// This will get replaced by the default `.js` handler
		throw new ERR_REQUIRE_ESM('');
	};

	const expected = 'module.exports = "foo";';
	let throwType = 'none';
	system.appendTransform(code => {
		switch (throwType) {
			case 'none':
				return expected;
			case 'syntax':
				throw new SyntaxError('simulate CJS parsing ESM');
			case 'normal':
				throw new Error('simulate non-parse error');
			default:
				return code;
		}
	}, '.foo');

	const module = system.load(fooFile);
	t.is(module.code, expected);

	delete system.cache[fooFile];
	throwType = 'syntax';
	t.throws(
		() => system.load(fooFile),
		ERR_REQUIRE_ESM
	);

	delete system.cache[fooFile];
	throwType = 'normal';
	t.throws(
		() => system.load(fooFile),
		'simulate non-parse error'
	);
});
