package brain

// spiral.go — coverage-biased variant.
//
// Identical to "automower" except for one extra reflex: while mowing it
// watches the cutting-disc current. A sustained rise means the mower has run
// into a patch that has grown long, so instead of ploughing one straight line
// through it, it switches to an expanding spiral (radius grows ~8 cm/s) until
// the current falls back or 45 s pass. That is Husqvarna's spiral-cutting
// feature and it clears dense patches noticeably faster than pure random
// bounce. Bumps, the wire and the range finder always win over the spiral.

import "github.com/styrops/huskvarna-demo/pkg/sdk"

// Fixed brain seeds keep whole runs reproducible: same engine seed + same
// brain = same trajectory.
const (
	brainSeedAutomower int64 = 1_000_003
	brainSeedSpiral    int64 = 2_000_003
)

func init() {
	sdk.Register("spiral", func() sdk.Brain {
		return newMower(
			"spiral",
			"Random bounce plus Husqvarna spiral cutting: a rise in blade "+
				"current means tall grass, so the mower spirals outwards to clear "+
				"the patch before resuming straight lines.",
			patternSpiral, brainSeedSpiral,
		)
	})
}
