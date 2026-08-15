all: build
.PHONY: all build web test clean graph

VERSION := $(shell git rev-parse --short HEAD)
BUILDTIME := $(shell date -u '+%Y-%m-%dT%H:%M:%SZ')

web:
	@go run cmd/build/main.go

build: web
	@CGO_ENABLED=0 go build -ldflags="-s -w" -o ./bin/buildai ./cmd/main.go

test:
	@go test ./... -race -count=1

clean:
	@rm -rf ./bin

run: build
	@./bin/buildai start --port 9090

run-edit: build
	@./bin/buildai start --port 9090 --edit
