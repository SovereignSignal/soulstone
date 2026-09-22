# Planning during verified shelter

This source-only experimental mode uses a protected pause to decide when to depart and prepare the first work plan before exposure. Enable `MC_SHELTER_PLANNING=1` when launching the companion service. It is independent of `MC_RECOVERY_MODE=adaptive`; comparisons keep that earlier open-ground pilot disabled.

The selected general planning provider makes these decisions. Jev continues to judge threat interruption and fight/evade/shelter responses. This feature does not make Jev the general task planner.

The observation includes the saved objective, inventory, loaded resources, current enclosure inspection, surface departure feasibility, and recent recovery outcomes. The structured response chooses `wait` or `depart`, gives a short checkable expectation, and supplies a normal work plan for after departure. A planner may decline an exit the basic guard permits. It cannot override the guard or invent an unsupported action.

While a model call is pending, enclosure and health checks continue independently. Stop, changed requests, changed connections, damage, or a breach prevent a late answer from dispatching. Calls are bounded to 30 seconds, with at most six attempts per saved request and a 180-second protected planning window. A fresh protected decision may run after the ordinary two-idle-continuation allowance is exhausted, provided the shared six-continuation cap and six-call budget still permit it. The ordinary automatic retry path keeps its idle cap. Each successful planned departure records the current explicit-Resume serial against the shared cap. Provider failure falls back to the established watch only if protection still verifies.

Departure freshly checks daylight, health, sprint reserve, the recorded surface landing, and separation from observed hostiles. It opens the existing exit, uses the existing flee executor when threats remain, then requires sustained open-ground clearance. Losing health or entering liquid aborts execution. A failed departure is journaled and returns to immediate safety recovery; it does not authorize the work plan.

A successful departure passes its plan to normal execution only for the matching request and connection and within 90 seconds of preparation. The plan is validated again and the ordinary executor and safety interruptions remain active. The prepared plan is consumed only for the first planning round; later failures use normal replanning. It is not persisted for reuse after a restart.

## Evaluation

Acceptance is retained resources within the time cap, survival without rescue, a return to productive work, and evidence that failure changes the next decision. Surviving underground alone is incomplete. Compare the current controller with this mode on matched supplied encounters, including a withheld terrain variation. Retain failed runs and record exact pre-encounter state, source version, model calls, shelter time, resource gains and departure outcomes.

Current evidence and limits are recorded in [support status](STATUS.md). Loaded entities and observed blocks do not establish future pursuit, an entirely safe route or general hostile-world survival. The current departure action uses the recorded exit and a fixed bounded escape; it cannot choose an arbitrary alternate tunnel or a new navigation destination.
