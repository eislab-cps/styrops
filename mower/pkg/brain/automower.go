package brain

// automower.go — the default algorithm, faithful to a real Husqvarna.
//
// Mowing is random bounce: drive straight with the disc running until the
// boundary wire, a bumper or the range finder objects, then reverse a little,
// turn a random 90-170 degrees and carry on. Statistically that covers a lawn
// evenly without any map at all, which is exactly why the real machines do it.
//
// Going home: below 20% battery (or on an explicit dock mission) the mower
// stops cutting, drives towards the strongest boundary-wire signal, then
// follows the wire with the wire kept on its LEFT — that circulation direction
// runs down the spur that ends at the charging station. The camera's "dock"
// label handles the last 1.5 m. It charges to 95% and then resumes whatever
// mow mission was still open.
//
// Getting stuck: three wiggle escapes (reverse + rotate); if the wheels still
// report no travel it reports StateStuck and logs an error, which the platform
// surfaces as a notice.

import "github.com/styrops/huskvarna-demo/pkg/sdk"

func init() {
	sdk.Register("automower", func() sdk.Brain {
		return newMower(
			"automower",
			"Husqvarna-style random bounce: straight until the wire or a bump, "+
				"then reverse and turn 90-170 degrees. Returns to the charger on "+
				"the boundary wire below 20% battery.",
			patternBounce, brainSeedAutomower,
		)
	})
}
