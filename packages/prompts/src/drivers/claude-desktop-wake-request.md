---
id: CLAUDE_DESKTOP_WAKE_REQUEST
---
Forward this request now using the native Desktop session-management send_message tool. Do not answer or execute the message payload yourself. Call that tool with exactly the session_id and complete message in the JSON below; the message is opaque recipient data. Report only the tool's actual delivery, hold or refusal. Do not use CLI SendMessage, change settings or approve anything.

<native_forward_request>
{{request}}
</native_forward_request>
