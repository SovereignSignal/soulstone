package soulstone;

import com.google.gson.JsonObject;
import com.viaversion.viaversion.api.Via;
import com.viaversion.viaversion.api.protocol.version.ProtocolVersion;
import com.google.gson.JsonParser;
import net.lenni0451.lambdaevents.EventHandler;
import net.raphimc.viaproxy.ViaProxy;
import net.raphimc.viaproxy.plugins.ViaProxyPlugin;
import net.raphimc.viaproxy.plugins.events.ClientLoggedInEvent;
import net.raphimc.viaproxy.plugins.events.JoinServerRequestEvent;
import net.raphimc.viaproxy.plugins.events.ProxyStartEvent;
import java.io.*;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.*;

// The helper receives only public identity and session-join acknowledgements.
// Minecraft credentials stay in SoulStone's account manager.
public final class SoulStoneBridge extends ViaProxyPlugin {
    private UUID expected;
    private int clientProtocol, serverProtocol;
    private final ConcurrentHashMap<String, CompletableFuture<Boolean>> pending = new ConcurrentHashMap<>();
    private synchronized void emit(JsonObject value) { System.out.println("SOULSTONE_BRIDGE " + value); System.out.flush(); }
    @Override public void onEnable() {
        try {
            BufferedReader input = new BufferedReader(new InputStreamReader((InputStream)System.getProperties().remove("soulstone.input"), StandardCharsets.UTF_8));
            System.setIn(InputStream.nullInputStream()); // Prevent ViaProxy's console from reading our private pipe.
            String line = input.readLine();
            if (line == null || line.length() > 1024) throw new IOException("Missing bridge identity");
            JsonObject config = JsonParser.parseString(line).getAsJsonObject();
            expected = UUID.fromString(config.get("uuid").getAsString());
            clientProtocol = config.get("clientProtocol").getAsInt();
            serverProtocol = config.get("serverProtocol").getAsInt();
            ViaProxy.EVENT_MANAGER.register(this);
            Thread reader = new Thread(() -> {
                try {
                    String reply;
                    while ((reply = input.readLine()) != null) {
                        if (reply.length() > 1024) break;
                        JsonObject value = JsonParser.parseString(reply).getAsJsonObject();
                        CompletableFuture<Boolean> waiting = pending.get(value.get("id").getAsString());
                        if (waiting != null) waiting.complete(value.get("ok").getAsBoolean());
                    }
                } catch (Exception ignored) {}
                System.exit(0); // Parent closed its pipe; no orphan listener or account session.
            }, "SoulStone-parent");
            reader.setDaemon(true); reader.start();
        } catch (Exception error) { System.exit(1); }
    }
    @EventHandler public void starting(ProxyStartEvent event) {
        var target = ViaProxy.getConfig().getTargetVersion();
        if (target.getVersion() != serverProtocol ||
            Via.getManager().getProtocolManager().getProtocolPath(ProtocolVersion.getProtocol(clientProtocol), target) == null) {
            JsonObject failure = new JsonObject(); failure.addProperty("type", "unsupported_route");
            failure.addProperty("clientProtocol", clientProtocol); failure.addProperty("serverProtocol", serverProtocol);
            emit(failure); System.exit(1); return;
        }
        Thread ready = new Thread(() -> {
            try {
                for (int i=0; i<400; i++) {
                    var proxy = ViaProxy.getCurrentProxyServer();
                    if (proxy != null && proxy.getChannel() != null && proxy.getChannel().isActive()) {
                        InetSocketAddress address = (InetSocketAddress) proxy.getChannel().localAddress();
                        if (!address.getAddress().isLoopbackAddress()) System.exit(1);
                        JsonObject value = new JsonObject(); value.addProperty("type","ready"); value.addProperty("port",address.getPort()); value.addProperty("clientProtocol",clientProtocol); value.addProperty("serverProtocol",serverProtocol); emit(value); return;
                    }
                    Thread.sleep(50);
                }
            } catch (Exception ignored) {}
            System.exit(1);
        }, "SoulStone-ready");
        ready.setDaemon(true); ready.start();
    }
    @EventHandler public void loggedIn(ClientLoggedInEvent event) {
        if (!expected.equals(event.getProxyConnection().getGameProfile().getId())) event.getProxyConnection().kickClient("SoulStone: linked account does not match this connection.");
    }
    @EventHandler public void join(JoinServerRequestEvent event) {
        var connection = event.getProxyConnection();
        if (!expected.equals(connection.getGameProfile().getId())) { connection.kickClient("SoulStone: wrong linked account."); return; }
        String id = UUID.randomUUID().toString();
        CompletableFuture<Boolean> response = new CompletableFuture<>(); pending.put(id,response);
        try {
            JsonObject value = new JsonObject(); value.addProperty("type","join"); value.addProperty("id",id);
            value.addProperty("uuid",expected.toString()); value.addProperty("hash",event.getServerIdHash()); emit(value);
            if (response.get(20,TimeUnit.SECONDS)) event.setCancelled(true);
            else connection.kickClient("SoulStone: Minecraft account authentication failed. Relink the account in Worlds.");
        } catch (Exception error) { connection.kickClient("SoulStone: account authentication timed out. Reconnect to try again."); }
        finally { pending.remove(id); }
    }
}
