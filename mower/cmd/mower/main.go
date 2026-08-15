// The mower binary: 2D garden simulator + embedded web UI + ColonyOS
// executor, in one process — "the robot". Chat runs browser→colonies-server
// directly: the user logs in with their own colony key in the UI.
//
// Run standalone (no colony):  ./bin/mower
// Run on the colony:           source <colonies env> && ./bin/mower
package main

import (
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	huskvarnademo "github.com/styrops/huskvarna-demo"
	_ "github.com/styrops/huskvarna-demo/pkg/brain" // register brains
	"github.com/styrops/huskvarna-demo/pkg/executor"
	"github.com/styrops/huskvarna-demo/pkg/server"
	"github.com/styrops/huskvarna-demo/pkg/sim"
)

func main() {
	addr := flag.String("addr", ":9595", "HTTP listen address")
	noColony := flag.Bool("no-colony", false, "run without ColonyOS (no executor)")
	execName := flag.String("executor-name", envOr("AUTOMOWER_NAME", "automower"), "colony executor name")
	location := flag.String("location", envOr("AUTOMOWER_LOCATION", "garden"), "colony location name")
	flag.Parse()

	engine := sim.New()
	go engine.Run()
	defer engine.Close()

	var exec *executor.Executor

	host := os.Getenv("COLONIES_SERVER_HOST")
	if *noColony || host == "" {
		slog.Warn("running WITHOUT ColonyOS — executor disabled")
	} else {
		port := 443
		if p, err := strconv.Atoi(os.Getenv("COLONIES_SERVER_PORT")); err == nil {
			port = p
		}
		insecure := os.Getenv("COLONIES_TLS") != "true" && os.Getenv("COLONIES_SERVER_TLS") != "true"
		colony := os.Getenv("COLONIES_COLONY_NAME")

		var err error
		exec, err = executor.New(executor.Config{
			ServerHost:   host,
			ServerPort:   port,
			Insecure:     insecure,
			ColonyName:   colony,
			ColonyPrvKey: os.Getenv("COLONIES_COLONY_PRVKEY"),
			Name:         *execName,
			Location:     *location,
		}, engine)
		if err != nil {
			slog.Error("executor registration failed — continuing without colony", "err", err)
		} else {
			go exec.Serve()
			defer exec.Close()
		}
	}

	srv := server.New(*addr, engine, huskvarnademo.WebFS())
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
		<-sig
		slog.Info("shutting down")
		srv.Close()
	}()
	if err := srv.Run(); err != nil {
		slog.Info("server stopped", "reason", err)
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
