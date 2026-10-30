# Alpha dependency status

The first alpha has not completed live Salesforce acceptance. Its deployment
tests simulate Salesforce while exercising real Git and Git Delta.

On 30 October 2026, `npm audit --omit=dev` on the locked dependency tree reports
36 inherited findings: 28 high and 8 moderate, with none marked critical.
These counts include propagation through parent packages, not 36 independent
defects in sfci. They are recorded here rather than hidden behind a clean test
result.

Same-major overrides apply patched versions where the dependency resolver permits
them. Git Delta's own published shrinkwrap and npm's bundled dependencies retain
some older nested versions. Remaining leaf findings include `basic-ftp`,
`marked`, `brace-expansion`, `fast-uri`, `ip-address`, `undici`, and `zod`.

Some suggested fixes require incompatible major versions. For example,
`marked-terminal` explicitly expects marked 1 or 2; forcing marked 4 globally
would bypass its compatibility contract. sfci does not silently make those major
changes. An upstream update, or a separately tested replacement, is needed.

Salesforce CLI automatic updates and telemetry are disabled in sfci's runtime,
and its user-installed plugin inventory is isolated. These controls do not
eliminate the dependency findings. The lock audit must be reviewed again before
promoting an alpha to a production release.

Do not put credentials, authorization URLs, or customer metadata in public issue
reports. The delivery core does not need production credentials for its tests.
