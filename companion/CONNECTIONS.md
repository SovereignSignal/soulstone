# Connect SoulStone to Minecraft

Use Minecraft **Java Edition**. For installation, start with [setup](../docs/SETUP.md). The connection form and account picker work before a game session is joined.

## LAN world on the same Mac

1. Start your Java world. Choose **Open to LAN → Start LAN World** and keep it open.
2. Note the port printed by Minecraft. It can change the next time you open the world.
3. In SoulStone, open **Agent connection → Change world or account…**, add/select the profile and choose **LAN on this Mac**. This sets the address to `127.0.0.1`.
4. Enter the port, leave Java version on `auto`, and choose **Check connection**. A successful ping checks reachability/version; it does not sign the agent in.
5. Enter your Java player name, link the bot's Java account, select an available provider/model and choose **Connect agent**.

The host and bot need distinct identities if they play together. Opening LAN under one account and also connecting the bot under that account still creates a duplicate identity.

## LAN world on another Mac

Keep the host world open to LAN. Use that Mac's reachable local-network address and the port Minecraft shows. `localhost` and `127.0.0.1` refer to the machine running SoulStone, so they do not reach the other Mac. Both machines need network reachability; check macOS local-network/firewall permissions if the ping fails.

## Dedicated server

Enter the server hostname/IP and port separately, without `https://` or a port in the address field. Confirm its Java version and allowlist/account requirements with its operator. Use a server you are authorized to connect to. No project VPN or private lab is needed for your own reachable server.

Leave version on `auto` for supported releases. Direct Java 1.21.4 and the bundled 26.2 compatibility route have scoped live evidence. Minecraft's installed Java runtime is required for the 26.2 helper. Do not infer gameplay compatibility for another version or modpack from a reachable ping; see [support](../docs/STATUS.md).

**Offline lab server** is an explicit development option for a server already configured to allow it. It is not the normal login mode for Java LAN or an online-mode server.

## Java accounts

Click **Link Minecraft account**. SoulStone displays a code, expiry countdown, copy button and Microsoft sign-in link. Complete the code flow using an account with Java access, then check the verified Java player name in SoulStone. The current authentication client may be labeled **Minecraft for Nintendo Switch** on Microsoft's page; SoulStone explains that before sign-in.

An Xbox gamertag is separate from the Java player profile. If no Java profile is found, finish Java player-name setup in Minecraft and relink. Do not share Microsoft passwords or authentication caches with the project owner.

Accounts have no permanent human/bot role. You may use an ordinary account for solo bot play when it is not already connected to that server. Playing together in the same world requires distinct identities. Follow/deliver-to-self is unavailable in solo use.

## Saved profiles and reconnection

**Save connection** stores valid connection details even before account/model setup is complete. **Connect agent** requires the full valid configuration and joins the game. A saved connection identifies the world and its history; a linked account identifies who joins and can be reused across profiles.

When a LAN port changes, edit the existing profile's port to preserve its world history. For a different world or server reset, choose **Add connection** or **Duplicate for another world**. Do not reuse an old world's identity for an unrelated world.

**Disconnect agent** pauses work and leaves the server while retaining account linkage and history. That choice persists across app restart. Use **Connect agent** to rejoin. Reconnection does not automatically replay a stopped request.

**Sign out & unlink…** confirms removal of the selected account's login and associations from SoulStone on this Mac. World history, other accounts, Minecraft ownership and Launcher/browser sign-in remain. **Remove saved connection…** confirms removal from the list while retaining the actual Minecraft world, linked accounts and local history.

For account rejection, missing helper or connection errors, use [troubleshooting](../docs/TROUBLESHOOTING.md).
