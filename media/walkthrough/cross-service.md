# Cross-service impact

Changed a DTO, an API route or an event? The **Cross-service** view searches your GitLab group for **other repositories and apps that use it**.

- Each contract gets an impact: *new*, *additive*, *modified* or **possibly breaking** (fields, enum values or routes removed or renamed).
- Click a usage to open it in GitLab; **💬** adds a draft comment listing the affected consumers.

Hover a name in untouched code and you'll see **"Affected by this MR"** when its definition changed.
