'use strict';
const path = require('path');
const js = require('default-require-extensions/js');

module.exports = appendTransform;

let count = 0;

function getterFromDescriptor(descriptor) {
	return descriptor.get ? descriptor.get : () => descriptor.value;
}

function getExtensionDescriptor(ext, extensions) {
	const descriptor = Object.getOwnPropertyDescriptor(extensions, ext);

	if (!descriptor) {
		return {value: js, configurable: true};
	}

	if (
		((descriptor.get || descriptor.set) && !(descriptor.get && descriptor.set)) ||
		!descriptor.configurable
	) {
		throw new Error('Somebody did bad things to require.extensions["' + ext + '"]');
	}

	const getFn = getterFromDescriptor(descriptor);
	// The alternative is to just attempt to execute and check for ERR_REQUIRE_ESM
	// but if another transpiler already hooked without unconditionally suppressing
	// the error we could end up removing that transpiler without ever reporting an
	// error.  Allowing `ERR_REQUIRE_ESM` is hopefully the better option.
	if (/throw\s*new\s*ERR_REQUIRE_ESM/.test(getFn().toString())) {
		return {
			value(...args) {
				try {
					return js(...args);
				} catch (error) {
					// If we get a SyntaxError then it's possible nothing is
					// tranforming ESM to CJS.  This means we need to call the
					// the default handler so outside code that checks for
					// ERR_REQUIRE_ESM can know to use `import()`.
					if (error instanceof SyntaxError) {
						return getFn()(...args);
					}

					throw error;
				}
			},
			configurable: true
		};
	}

	return descriptor;
}

// eslint-disable-next-line node/no-deprecated-api
function appendTransform(transform, ext = '.js', extensions = require.extensions) {
	// Generate a unique key for this transform
	const key = path.join(__dirname, count.toString());
	count++;

	let forwardGet;
	let forwardSet;

	const descriptor = getExtensionDescriptor(ext, extensions);

	if (descriptor.get) {
		// Wrap a previous append-transform install and pass through to the getter/setter pair it created
		forwardGet = function () {
			return descriptor.get();
		};

		forwardSet = function (val) {
			descriptor.set(val);
			return forwardGet();
		};
	} else {
		forwardGet = function () {
			return descriptor.value;
		};

		forwardSet = function (val) {
			descriptor.value = val;
			return val;
		};
	}

	function wrapCustomHook(hook) {
		return function (module, filename) {
			// We wrap every added extension, but we only apply the transform to the one on top of the stack
			if (!module[key]) {
				module[key] = true;

				const originalCompile = module._compile;

				// eslint-disable-next-line func-name-matching, func-names
				module._compile = function replacementCompile(code, filename) {
					module._compile = originalCompile;
					code = transform(code, filename);
					module._compile(code, filename);
				};
			}

			hook(module, filename);
		};
	}

	// Wrap the original
	forwardSet(wrapCustomHook(forwardGet()));

	const hooks = [forwardGet()];

	function setCurrentHook(hook) {
		const restoreIndex = hooks.indexOf(hook);

		if (restoreIndex === -1) {
			hooks.push(forwardSet(wrapCustomHook(hook)));
		} else {
			// We have already seen this hook, and it is being reverted (proxyquire, etc) - don't wrap again.
			hooks.splice(restoreIndex + 1, hooks.length);
			forwardSet(hook);
		}
	}

	Object.defineProperty(extensions, ext, {
		configurable: true,
		enumerable: true,
		get: forwardGet,
		set: setCurrentHook
	});
}
