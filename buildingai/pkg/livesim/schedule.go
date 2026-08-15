package livesim

import (
	"hash/fnv"
	"math/rand"
	"time"
)

// A teaching slot, in minutes since midnight. These are the classic Swedish
// university slots (kvart över, i.e. lectures start at :15).
type slot struct {
	start int
	end   int
}

var slots = []slot{
	{8*60 + 15, 10 * 60},    // 08:15 - 10:00
	{10*60 + 15, 12 * 60},   // 10:15 - 12:00
	{13*60 + 15, 15 * 60},   // 13:15 - 15:00
	{15*60 + 15, 17*60 + 0}, // 15:15 - 17:00
}

// bookingProbability is the chance that a given class has a lecture in a given
// slot on a given weekday. ~2.6 lectures per class per day.
const bookingProbability = 0.65

// Booking is one scheduled lecture: a class in a room with a teacher.
type Booking struct {
	Weekday time.Weekday `json:"weekday"`
	Slot    int          `json:"slot"`
	Start   string       `json:"start"` // "08:15"
	End     string       `json:"end"`   // "10:00"
	Room    RoomKey      `json:"room"`
	Class   int          `json:"class"`
	Teacher string       `json:"teacher,omitempty"` // person id
}

type schedule struct {
	// byKey is indexed by {weekday, slot, class}.
	byKey   map[[3]int]*Booking
	all     []Booking
	classes int
}

func newSchedule(classes int) *schedule {
	return &schedule{byKey: map[[3]int]*Booking{}, classes: classes}
}

func (s *schedule) lookup(wd time.Weekday, slotIdx, class int) *Booking {
	if s == nil {
		return nil
	}
	return s.byKey[[3]int{int(wd), slotIdx, class}]
}

// at returns every booking running at a given weekday/minute.
func (s *schedule) at(wd time.Weekday, minutes int) []Booking {
	var out []Booking
	idx := slotAt(minutes)
	if idx < 0 || s == nil {
		return out
	}
	for c := 0; c < s.classes; c++ {
		if b := s.lookup(wd, idx, c); b != nil {
			out = append(out, *b)
		}
	}
	return out
}

// buildSchedule synthesizes a weekly lecture timetable over the real lecture
// rooms. Two classes never share a room in the same slot, and a teacher never
// teaches two classes at once.
func buildSchedule(rng *rand.Rand, rooms []*Room, classes int, teachers []string) *schedule {
	sch := newSchedule(classes)
	if len(rooms) == 0 || classes <= 0 {
		return sch
	}
	for wd := time.Monday; wd <= time.Friday; wd++ {
		for si := range slots {
			usedRoom := map[RoomKey]bool{}
			usedTeacher := map[string]bool{}
			for c := 0; c < classes; c++ {
				if rng.Float64() >= bookingProbability {
					continue
				}
				var room *Room
				for try := 0; try < 8; try++ {
					cand := rooms[rng.Intn(len(rooms))]
					if !usedRoom[cand.Key] {
						room = cand
						break
					}
				}
				if room == nil {
					continue
				}
				usedRoom[room.Key] = true

				teacher := ""
				for try := 0; try < 8 && len(teachers) > 0; try++ {
					cand := teachers[rng.Intn(len(teachers))]
					if !usedTeacher[cand] {
						teacher = cand
						break
					}
				}
				if teacher != "" {
					usedTeacher[teacher] = true
				}

				b := &Booking{
					Weekday: wd,
					Slot:    si,
					Start:   hhmm(slots[si].start),
					End:     hhmm(slots[si].end),
					Room:    room.Key,
					Class:   c,
					Teacher: teacher,
				}
				sch.byKey[[3]int{int(wd), si, c}] = b
			}
		}
	}
	for _, b := range sch.byKey {
		sch.all = append(sch.all, *b)
	}
	return sch
}

// slotAt returns the index of the teaching slot covering a time of day, or -1
// during breaks, lunch, evenings and nights.
func slotAt(minutes int) int {
	for i, s := range slots {
		if minutes >= s.start && minutes < s.end {
			return i
		}
	}
	return -1
}

func hhmm(minutes int) string {
	h := minutes / 60
	m := minutes % 60
	return string([]byte{byte('0' + h/10), byte('0' + h%10), ':', byte('0' + m/10), byte('0' + m%10)})
}

func minutesOfDay(t time.Time) int { return t.Hour()*60 + t.Minute() }

func isWorkday(wd time.Weekday) bool {
	return wd != time.Saturday && wd != time.Sunday
}

// === deterministic hashing =================================================
//
// Per-person, per-day variation (when someone arrives, when they take lunch)
// must be stable across restarts and independent of iteration order, so it is
// derived by hashing rather than drawn from a stream of random numbers.

func hashInts(seed int64, vals ...int) uint64 {
	h := fnv.New64a()
	var buf [8]byte
	put := func(v uint64) {
		for i := 0; i < 8; i++ {
			buf[i] = byte(v >> (8 * i))
		}
		_, _ = h.Write(buf[:])
	}
	put(uint64(seed))
	for _, v := range vals {
		put(uint64(int64(v)))
	}
	return h.Sum64()
}

// spread maps a hash to [0, n).
func spread(h uint64, n int) int {
	if n <= 0 {
		return 0
	}
	return int(h % uint64(n))
}

// chance maps a hash to a deterministic "coin flip" with probability p.
func chance(h uint64, p float64) bool {
	return float64(h%10000)/10000.0 < p
}

// dayPlan is when one person is in the building on one particular day.
type dayPlan struct {
	present bool
	arrive  int // minutes since midnight
	depart  int
	lunch   int // lunch start, minutes since midnight
	lunchTo int // lunch end
}

// planFor derives a person's day deterministically from (seed, person, date).
func (s *Sim) planFor(p *person, day time.Time) dayPlan {
	yd := day.Year()*1000 + day.YearDay()
	h := hashInts(s.cfg.Seed, p.index, yd)
	wd := day.Weekday()

	if !isWorkday(wd) {
		// A thin weekend crew: a few staff catching up, a few students in the
		// study halls.
		prob := 0.10
		if p.role == roleStaff {
			prob = 0.14
		}
		if !chance(h, prob) {
			return dayPlan{}
		}
		arrive := 10*60 + spread(h>>8, 90)
		depart := arrive + 120 + spread(h>>16, 200)
		return dayPlan{present: true, arrive: arrive, depart: depart,
			lunch: 12 * 60, lunchTo: 12*60 + 30}
	}

	// Almost everyone is in on a weekday; a few are ill / working elsewhere.
	if chance(h>>40, 0.08) {
		return dayPlan{}
	}

	var arrive, depart int
	if p.role == roleStaff {
		arrive = 7*60 + 30 + spread(h>>8, 75)
		depart = 16*60 + spread(h>>16, 120)
	} else {
		first, last := s.classDayRange(p.class, wd)
		if first >= 0 {
			arrive = slots[first].start - 20 - spread(h>>8, 25)
			depart = slots[last].end + 5 + spread(h>>16, 40)
		} else {
			arrive = 9*60 + spread(h>>8, 60)
			depart = 15*60 + spread(h>>16, 90)
		}
	}
	if arrive < 6*60 {
		arrive = 6 * 60
	}
	if depart > 21*60+30 {
		depart = 21*60 + 30
	}
	if depart < arrive+60 {
		depart = arrive + 60
	}

	lunch := 11*60 + 30 + spread(h>>24, 60)
	return dayPlan{present: true, arrive: arrive, depart: depart,
		lunch: lunch, lunchTo: lunch + 30 + spread(h>>32, 25)}
}

// classDayRange is the first and last booked slot of a class on a weekday.
func (s *Sim) classDayRange(class int, wd time.Weekday) (first, last int) {
	first, last = -1, -1
	for si := range slots {
		if s.sched.lookup(wd, si, class) == nil {
			continue
		}
		if first < 0 {
			first = si
		}
		last = si
	}
	return
}

// desiredRoom answers "where should this person be right now?".
// An empty RoomKey means "outside the building".
func (s *Sim) desiredRoom(p *person, now time.Time) RoomKey {
	plan := s.planFor(p, now)
	if !plan.present {
		return RoomKey{}
	}
	m := minutesOfDay(now)
	if m < plan.arrive || m >= plan.depart {
		return RoomKey{}
	}
	if m >= plan.lunch && m < plan.lunchTo {
		return p.lunch
	}

	wd := now.Weekday()
	si := slotAt(m)

	if p.role == roleStudent {
		if si >= 0 && isWorkday(wd) {
			if b := s.sched.lookup(wd, si, p.class); b != nil {
				return b.Room
			}
		}
		return p.home // study space between lectures
	}

	// Staff: teaching beats meetings, meetings beat the office.
	if si >= 0 && isWorkday(wd) {
		for c := 0; c < s.sched.classes; c++ {
			if b := s.sched.lookup(wd, si, c); b != nil && b.Teacher == p.id {
				return b.Room
			}
		}
		if !p.meeting.zero() {
			yd := now.Year()*1000 + now.YearDay()
			if chance(hashInts(s.cfg.Seed+7, p.index, yd, si), 0.22) {
				return p.meeting
			}
		}
	}
	return p.home // office
}
