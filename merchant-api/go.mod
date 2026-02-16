module github.com/DigitalGuards/merchant-api

go 1.24.0

require (
	github.com/google/uuid v1.6.0
	github.com/lib/pq v1.10.9
	github.com/theQRL/go-qrllib v0.0.0-00010101000000-000000000000
)

require (
	golang.org/x/crypto v0.48.0 // indirect
	golang.org/x/sys v0.41.0 // indirect
)

replace github.com/theQRL/go-qrllib => ../go-qrllib
