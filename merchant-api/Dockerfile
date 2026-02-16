FROM golang:1.24-alpine AS builder

WORKDIR /build

# Copy go-qrllib dependency (used via replace directive)
COPY go-qrllib/ ./go-qrllib/

# Copy merchant-api source
COPY merchant-api/go.mod merchant-api/go.sum ./merchant-api/
WORKDIR /build/merchant-api
RUN go mod download

COPY merchant-api/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /merchant-api ./cmd/merchant-api

FROM alpine:3.21

RUN apk add --no-cache ca-certificates tzdata
RUN adduser -D -u 1000 appuser

COPY --from=builder /merchant-api /usr/local/bin/merchant-api

USER appuser
EXPOSE 8080

ENTRYPOINT ["merchant-api"]
