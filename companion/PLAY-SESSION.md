# First play session

Complete [setup](../docs/SETUP.md) and [connect a world](CONNECTIONS.md). Use a disposable Java world in Peaceful difficulty for this first check. Wait for the app to show the agent connected and its selected model ready.

## A small, observable goal

Start with a status question:

```text
What are you carrying?
```

If a reachable oak tree is nearby, try:

```text
Collect one oak log.
```

Check the inventory and the actual Minecraft result. If there are no reachable trees, a clear blocker is a valid diagnosis; move to a suitable area or choose a different small task. This is a usability check, not a promise that arbitrary terrain can be handled.

When playing as a separate human account, try:

```text
Follow me.
```

## Cancellation and recovery

During an ordinary request, click **Stop bot** and verify movement/work stops. Stop cancels that request; completed changes stay in the world. Send a new request if you want different work. **Resume task** is only for a blocked or interrupted request when the app offers it.

Try a connection disconnect/reconnect after the agent is idle. Confirm the same saved world and identity appear. Do not delete the profile or app data to reconnect.

Text is sufficient. Test Talk and spoken replies separately if you want voice; a successful build does not establish microphone/transcription behavior on your Mac.

## What to report

A useful first installation passes when the app starts from your clone, signs in with your own accounts, joins your world, reports observed inventory, completes a small task or explains its blocker, and responds to Stop. Record your platform, Minecraft version, request and any intervention. Broader mining, construction or hostile survival has additional [limits](../docs/STATUS.md).
