package soulstone;
import java.io.InputStream;
public final class SoulStoneLauncher {
    public static void main(String[] args) throws Throwable {
        // Reserve stdin before ViaProxy starts its command console.
        System.getProperties().put("soulstone.input",System.in);
        System.setIn(InputStream.nullInputStream());
        net.raphimc.viaproxy.ViaProxy.main(args);
    }
}
