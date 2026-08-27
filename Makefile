.PHONY: dev dev-worker dev-web smoke test lint build

dev:
	node scripts/dev.mjs

dev-worker:
	npm run dev --workspace @home-os/worker

dev-web:
	npm run dev --workspace @home-os/web

smoke:
	node scripts/smoke.mjs

test:
	npm test

lint:
	npm run lint

build:
	npm run build
