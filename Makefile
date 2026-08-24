.PHONY: dev-api dev-web test lint build

dev-api:
	cd apps/api && go run ./cmd/server

dev-web:
	npm run dev --workspace @home-os/web

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
