.PHONY: build run test clean

build:
	go build -o bin/merchant-api ./cmd/merchant-api

run: build
	./bin/merchant-api

test:
	go test -v -race ./...

clean:
	rm -rf bin/
