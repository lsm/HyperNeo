# Neo failed input retry

Build and drive the actual web interface against an isolated daemon with
`neo-ui-retry.sh` using the setup in SKILL.md. The fixture seeds a failed human
input with a synthetic refusal reason. Check the visible error and Retry button
in light and dark themes, click Retry, and require one linked new input. Reload
and require the original to remain marked Retried without another Retry button.
First make the displayed failed state stale and check the retry rejection appears
as a readable error, then restore the failed fixture and retry normally.
Keep the screenshots, `neo-ui-retry.json`, daemon log and wrapper exit status.
