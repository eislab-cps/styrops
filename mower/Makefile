.PHONY: build run test vet clean

build:
	go build -o bin/mower ./cmd/mower

run: build
	./bin/mower

test:
	go test ./... -race -count=1

vet:
	go vet ./...

clean:
	rm -rf bin
