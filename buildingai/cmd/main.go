package main

import (
	"fmt"
	"os"
	"time"

	"github.com/spf13/cobra"
	buildingsim "github.com/styrops/buildingai"
	"github.com/styrops/buildingai/pkg/livesim"
	"github.com/styrops/buildingai/pkg/server"
)

var rootCmd = &cobra.Command{
	Use:   "buildsim",
	Short: "Building simulation server",
}

var startCmd = &cobra.Command{
	Use:   "start",
	Short: "Start the BuildSim server",
	RunE: func(cmd *cobra.Command, args []string) error {
		port, _ := cmd.Flags().GetInt("port")
		edit, _ := cmd.Flags().GetBool("edit")
		srv := server.New(port, buildingsim.DataFS, buildingsim.WebFS, edit)

		live := livesim.DefaultConfig()
		live.Enabled, _ = cmd.Flags().GetBool("livesim")
		live.Speed, _ = cmd.Flags().GetFloat64("livesim-speed")
		live.People, _ = cmd.Flags().GetInt("livesim-people")
		live.Seed, _ = cmd.Flags().GetInt64("livesim-seed")
		live.Tick, _ = cmd.Flags().GetDuration("livesim-tick")
		live.Provision, _ = cmd.Flags().GetBool("livesim-provision")
		live.WriteOccupancy, _ = cmd.Flags().GetBool("livesim-occupancy")
		live.Broadcast, _ = cmd.Flags().GetBool("livesim-broadcast")
		if startAt, _ := cmd.Flags().GetString("livesim-start"); startAt != "" {
			t, err := parseStart(startAt)
			if err != nil {
				return err
			}
			live.Start = t
		}
		srv.Live = live

		return srv.Start()
	},
}

// parseStart accepts either a full RFC3339 timestamp, taken literally, or a
// local "HH:MM" time of day, resolved against today's date and moved to the
// next weekday if that would start the demo on an empty weekend building.
func parseStart(s string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t, nil
	}
	if t, err := time.Parse("15:04", s); err == nil {
		now := time.Now()
		return livesim.SnapToWeekday(
			time.Date(now.Year(), now.Month(), now.Day(), t.Hour(), t.Minute(), 0, 0, now.Location())), nil
	}
	return time.Time{}, fmt.Errorf("invalid --livesim-start %q: use RFC3339 or HH:MM", s)
}

func init() {
	startCmd.Flags().IntP("port", "p", 9090, "Port to listen on")
	startCmd.Flags().Bool("edit", false, "Enable floor plan editing tools")

	d := livesim.DefaultConfig()
	startCmd.Flags().Bool("livesim", d.Enabled, "Run the living-building simulation (people, occupancy, sensor dynamics)")
	startCmd.Flags().Float64("livesim-speed", d.Speed, "Simulated seconds per real second (60 = a day every 24 minutes)")
	startCmd.Flags().Int("livesim-people", d.People, "Size of the simulated population")
	startCmd.Flags().Int64("livesim-seed", d.Seed, "Random seed: same seed, same building day")
	startCmd.Flags().Duration("livesim-tick", d.Tick, "Real-time interval between simulation steps")
	startCmd.Flags().String("livesim-start", "", "Simulated start time, RFC3339 or HH:MM (default: today 07:00, next Monday if a weekend)")
	startCmd.Flags().Bool("livesim-provision", d.Provision, "Create livesim climate/energy equipment in the rooms it uses")
	startCmd.Flags().Bool("livesim-occupancy", d.WriteOccupancy, "Let the simulation own the global /api/occupancy map")
	startCmd.Flags().Bool("livesim-broadcast", d.Broadcast, "Push {\"type\":\"live\"} WebSocket messages when occupancy changes")

	rootCmd.AddCommand(startCmd)
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
