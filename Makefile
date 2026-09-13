.PHONY: clean verify lint lint-fix test-unit test-integration test-all ccm-install

clean:
	rm -rf dist

verify:
	npm run verify

lint:
	npm run lint

lint-fix:
	npm run lint -- --fix

test-unit:
	npm test

ccm-install:
	npm run ccm:install

test-integration: ccm-install
	npm run test:integration

test-all: test-integration
