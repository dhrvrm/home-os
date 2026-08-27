.PHONY: dev dev-api dev-web smoke test lint build

dev:
	node scripts/dev.mjs

dev-api:
	cd apps/api && go run ./cmd/server

dev-web:
	npm run dev --workspace @home-os/web

smoke:
	node scripts/smoke.mjs

test:
	go test ./apps/api/...
	npm run test --workspace @home-os/web

lint:
	go vet ./apps/api/...
	npm run lint --workspace @home-os/web

build:
	mkdir -p bin
	go build -o bin/home-os-api ./apps/api/cmd/server
	npm run build --workspace @home-os/web
