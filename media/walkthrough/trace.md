# Trace a changed function

Above every function the MR changed there's a **⧉ Trace callers & callees** link (or press **`Alt+T`** anywhere).

The trace shows **who calls it**, up to controllers, React components, jobs and tests, and **what it calls**, across:

- React: component → hook → **API endpoint** (RTK Query)
- **HTTP**: frontend endpoint → backend **controller** in the right service
- services → repositories → helpers

Boxes are apps and services, so you see immediately when a change crosses a boundary. The **Impact** view lists callers of changed functions for the open file, and warns about callers outside the MR.
