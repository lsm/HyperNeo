## Retired Neo-only model runtime

The Neo-only fallback override and idle primary-restoration runtime were removed
in #8114. Those model choices now follow ordinary session configuration and the
shared provider recovery policy. The former helper asserted behavior that no
longer exists and has been removed. Use the shared model-switch/fallback suites
for provider recovery, and [ordinary restart delivery](spent-admission-restart.md)
for Neo/ordinary feed parity. Existing saved preferences are retained as data;
this journey does not claim that a Neo-only fallback list still affects queries.
