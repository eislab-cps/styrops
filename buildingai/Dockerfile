FROM golang:latest AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go run cmd/build/main.go
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o buildai ./cmd/main.go

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /app
COPY --from=build /app/buildai .
EXPOSE 9090
ENTRYPOINT ["./buildai", "start", "--port", "9090"]
