package vn.mcbotctl.party;

import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.command.CommandSender;
import org.bukkit.Material;
import org.bukkit.inventory.ItemStack;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Reference party plugin for mcbotctl.
 *
 * The point is not to be a full party plugin, but a VERIFICATION TARGET
 * for the bot: every subcommand name and every message is read from config.yml, so you can
 * change them all and re-run the bot to check whether mcbotctl is really configurable.
 *
 * Only uses API available since Bukkit 1.8 (no api-version, no tab completer).
 */
public class PartyPlugin extends JavaPlugin implements CommandExecutor, Listener {

    /** leader UUID -> set of member UUIDs (does not include the leader itself) */
    private final Map<UUID, Set<UUID>> parties = new HashMap<UUID, Set<UUID>>();
    /** member UUID -> leader UUID */
    private final Map<UUID, UUID> memberOf = new HashMap<UUID, UUID>();
    /** invited player UUID -> inviting player UUID */
    private final Map<UUID, UUID> invites = new HashMap<UUID, UUID>();

    private final Map<String, String> sub = new HashMap<String, String>();

    /** Players who have marked themselves offline. A status, not a disconnection: the account
     *  stays connected, it is just telling the rest of the party it is done for now. */
    private final java.util.Set<java.util.UUID> offline = new java.util.HashSet<java.util.UUID>();
    private BedWarsSim bedWarsSim;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        String[] keys = { "invite", "accept", "deny", "leave", "disband", "transfer", "promote", "list", "chat", "kick" };
        for (String k : keys) {
            sub.put(k, getConfig().getString("subcommands." + k, k).toLowerCase());
        }
        getCommand("p").setExecutor(this);
        getServer().getPluginManager().registerEvents(this, this);
        getServer().getPluginManager().registerEvents(new MenuSim(this), this);
        bedWarsSim = new BedWarsSim(this);
        getCommand("bwtest").setExecutor(bedWarsSim);
        getCommand("bwstatus").setExecutor(bedWarsSim);
        getServer().getPluginManager().registerEvents(bedWarsSim, this);
        getLogger().info("McbotctlParty enabled. Subcommands: inv=" + sub.get("invite")
                + " accept=" + sub.get("accept") + " disband=" + sub.get("disband")
                + " transfer=" + sub.get("transfer"));
    }

    @Override
    public void onDisable() {
        if (bedWarsSim != null) bedWarsSim.dispose();
    }

    /** Without this step, a player who quits is still treated as being in the party, and on the next
     *  run the bot will receive "The player X is already in a party." — exactly the bug we hit in practice. */
    @EventHandler
    public void onQuit(PlayerQuitEvent e) {
        java.util.UUID u = e.getPlayer().getUniqueId();
        invites.remove(u);
        offline.remove(u);
        if (isMember(u)) {
            java.util.UUID leader = leaderOf(u);
            java.util.Set<java.util.UUID> m = parties.get(leader);
            if (m != null) m.remove(u);
            memberOf.remove(u);
            broadcast(leader, msg("leftBroadcast", "player", e.getPlayer().getName()));
        } else if (parties.containsKey(u)) {
            broadcast(u, msg("disbanded"));
            destroyParty(u);
        }
    }

    // ---------------------------------------------------------------- utilities

    private String msg(String key, Object... kv) {
        String s = getConfig().getString("messages." + key, "&c[missing message: " + key + "]");
        for (int i = 0; i + 1 < kv.length; i += 2) {
            s = s.replace("{" + kv[i] + "}", String.valueOf(kv[i + 1]));
        }
        return ChatColor.translateAlternateColorCodes('&', s);
    }

    private UUID leaderOf(UUID u) {
        UUID l = memberOf.get(u);
        return l == null ? u : l;
    }

    private boolean isMember(UUID u) {
        return memberOf.containsKey(u);
    }

    /** Every member of the party led by `leader`, INCLUDING the leader. */
    private List<Player> partyPlayers(UUID leader) {
        List<Player> out = new ArrayList<Player>();
        Player l = Bukkit.getPlayer(leader);
        if (l != null) out.add(l);
        Set<UUID> m = parties.get(leader);
        if (m != null) {
            for (UUID u : m) {
                Player p = Bukkit.getPlayer(u);
                if (p != null) out.add(p);
            }
        }
        return out;
    }

    private void broadcast(UUID leader, String text) {
        for (Player p : partyPlayers(leader)) p.sendMessage(text);
    }

    /** Erase every trace of a party. */
    private void destroyParty(UUID leader) {
        Set<UUID> m = parties.remove(leader);
        if (m != null) for (UUID u : m) memberOf.remove(u);
        memberOf.remove(leader);
        // also clear out the dangling invites of the former members
        List<UUID> stale = new ArrayList<UUID>();
        for (Map.Entry<UUID, UUID> e : invites.entrySet()) {
            if (e.getValue().equals(leader)) stale.add(e.getKey());
        }
        for (UUID u : stale) invites.remove(u);
    }

    // ------------------------------------------------------------- command

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!(sender instanceof Player)) {
            sender.sendMessage("This command is for players only.");
            return true;
        }
        Player p = (Player) sender;

        // /pc <content> — party chat
        if (command.getName().equalsIgnoreCase("pc")) {
            return partyChat(p, args);
        }

        // /where — the single most useful thing when testing movement: the SERVER's own idea of
        // where this player is. A bot that believes it walked somewhere proves nothing; this does.
        // Handled before the subcommand parsing below, because "where" is not a party subcommand.
        if (command.getName().equalsIgnoreCase("where")) {
            org.bukkit.Location l = p.getLocation();
            p.sendMessage(String.format("POS %.2f %.2f %.2f yaw=%.0f pitch=%.0f onGround=%s",
                    l.getX(), l.getY(), l.getZ(), l.getYaw(), l.getPitch(), p.isOnGround()));
            return true;
        }

        // /reset — drop the player somewhere open, so a measurement always starts from the same
        // place. Without it a movement test measures whatever wall the previous test walked into.
        if (command.getName().equalsIgnoreCase("reset")) {
            org.bukkit.Location sp = p.getWorld().getSpawnLocation();
            p.teleport(new org.bukkit.Location(p.getWorld(), sp.getX() + 0.5, 100, sp.getZ() + 0.5));
            p.setVelocity(new org.bukkit.util.Vector(0, 0, 0));
            p.setFallDistance(0);
            p.sendMessage(String.format("RESET %.2f %.2f %.2f", p.getLocation().getX(), p.getLocation().getY(), p.getLocation().getZ()));
            return true;
        }

        // /blockat <x> <y> <z> — the SERVER's view of a block. The only way to prove a client
        // actually placed something: a bot that believes it placed a block proves nothing.
        if (command.getName().equalsIgnoreCase("blockat")) {
            if (args.length < 3) { p.sendMessage("Usage: /blockat <x> <y> <z>"); return true; }
            try {
                int x = (int) Double.parseDouble(args[0]);
                int y = (int) Double.parseDouble(args[1]);
                int z = (int) Double.parseDouble(args[2]);
                org.bukkit.block.Block b = p.getWorld().getBlockAt(x, y, z);
                p.sendMessage(String.format("BLOCK %d %d %d %s", x, y, z, b.getType().name()));
            } catch (NumberFormatException e) { p.sendMessage("Usage: /blockat <x> <y> <z>"); }
            return true;
        }

        // /blocks — a stack of building blocks in hotbar slot 1, so a placement test always starts
        // with something to place and does not depend on the server's gamemode.
        if (command.getName().equalsIgnoreCase("blocks")) {
            p.getInventory().setItem(0, new ItemStack(Material.WOOL, 64, (short) 14));   // red wool
            p.sendMessage("BLOCKS given in hotbar slot 1");
            return true;
        }

        // /platform — a single block in mid-air with nothing around it. A bridging test needs an
        // edge to walk off; open ground only proves the bot can place blocks on grass.
        if (command.getName().equalsIgnoreCase("platform")) {
            org.bukkit.World w = p.getWorld();
            org.bukkit.Location sp = w.getSpawnLocation();
            int px = sp.getBlockX() + 60, pz = sp.getBlockZ() + 60, py = 90;
            // clear a pocket of air so nothing interferes
            for (int dx = -4; dx <= 4; dx++)
                for (int dz = -4; dz <= 4; dz++)
                    for (int dy = -1; dy <= 5; dy++)
                        w.getBlockAt(px + dx, py + dy, pz + dz).setType(Material.AIR);
            w.getBlockAt(px, py - 1, pz).setType(Material.STONE);
            p.teleport(new org.bukkit.Location(w, px + 0.5, py, pz + 0.5, 0f, 0f));
            p.setVelocity(new org.bukkit.util.Vector(0, 0, 0));
            p.setFallDistance(0);
            p.getInventory().setItem(0, new ItemStack(Material.WOOL, 64, (short) 14));
            p.sendMessage(String.format("PLATFORM %d %d %d", px, py, pz));
            return true;
        }

        // /off — mark yourself offline for the party. Deliberately NOT a disconnect: the account
        // stays connected so the party still knows who it has, it is just standing down.
        if (command.getName().equalsIgnoreCase("off")) {
            offline.add(p.getUniqueId());
            p.sendMessage(msg("offlineSelf"));
            broadcast(leaderOf(p.getUniqueId()), msg("offlineParty", "player", p.getName()));
            getLogger().info("[party] " + p.getName() + " marked offline");
            return true;
        }

        if (args.length == 0) {
            p.sendMessage(msg("usage"));
            return true;
        }

        String s = args[0].toLowerCase();
        if (s.equals(sub.get("invite")))   return doInvite(p, args);
        if (s.equals(sub.get("accept")))   return doAccept(p, args);
        if (s.equals(sub.get("deny")))     return doDeny(p, args);
        if (s.equals(sub.get("leave")))    return doLeave(p);
        if (s.equals(sub.get("disband")))  return doDisband(p);
        if (s.equals(sub.get("transfer"))) return doTransfer(p, args);
        if (s.equals(sub.get("promote")))  return doPromote(p, args);
        if (s.equals(sub.get("list")))     return doList(p);
        if (s.equals(sub.get("chat")))     return partyChat(p, tail(args));
        if (s.equals(sub.get("kick")))     return doKick(p, args);

        p.sendMessage(msg("usage"));
        return true;
    }

    private String[] tail(String[] args) {
        if (args.length <= 1) return new String[0];
        String[] out = new String[args.length - 1];
        System.arraycopy(args, 1, out, 0, out.length);
        return out;
    }

    private Player target(String[] args) {
        if (args.length < 2) return null;
        return Bukkit.getPlayerExact(args[1]);
    }

    // ------------------------------------------------------------ actions

    private boolean doInvite(Player p, String[] args) {
        Player t = target(args);
        if (t == null) { p.sendMessage(msg("noPlayer")); return true; }
        if (t.equals(p)) { p.sendMessage(msg("selfInvite")); return true; }
        if (isMember(p.getUniqueId())) { p.sendMessage(msg("notLeader")); return true; }
        if (isMember(t.getUniqueId())) {
            p.sendMessage(msg("alreadyInParty", "player", t.getName())); return true;
        }
        if (invites.containsKey(t.getUniqueId())) {
            p.sendMessage(msg("alreadyInvited", "player", t.getName())); return true;
        }
        invites.put(t.getUniqueId(), p.getUniqueId());
        p.sendMessage(msg("inviteSent", "player", t.getName()));
        t.sendMessage(msg("inviteReceived", "player", p.getName(), "sub", sub.get("accept")));
        return true;
    }

    private boolean doAccept(Player p, String[] args) {
        UUID inviter = invites.get(p.getUniqueId());
        if (inviter == null) { p.sendMessage(msg("noInvite")); return true; }

        Player named = target(args);
        if (named != null && !named.getUniqueId().equals(inviter)) {
            p.sendMessage(msg("noInvite")); return true;
        }
        if (isMember(p.getUniqueId())) { p.sendMessage(msg("alreadyInParty", "player", p.getName())); return true; }

        // getPlayer() returns null for someone who has logged out, and String.valueOf(UUID) then
        // puts a raw UUID into the "You joined X's party!" line. The bot reads that line to learn
        // who leads its party, so an offline inviter produced a leader name no rule could match.
        String leaderName = String.valueOf(inviter);
        Player lp = Bukkit.getPlayer(inviter);
        if (lp != null) leaderName = lp.getName();
        else {
            org.bukkit.OfflinePlayer op = Bukkit.getOfflinePlayer(inviter);
            if (op != null && op.getName() != null) leaderName = op.getName();
        }

        Set<UUID> m = parties.get(inviter);
        if (m == null) { m = new HashSet<UUID>(); parties.put(inviter, m); }
        m.add(p.getUniqueId());
        memberOf.put(p.getUniqueId(), inviter);
        invites.remove(p.getUniqueId());

        p.sendMessage(msg("joined", "leader", leaderName));
        broadcast(inviter, msg("joinedBroadcast", "player", p.getName()));
        return true;
    }

    private boolean doDeny(Player p, String[] args) {
        UUID inviter = invites.remove(p.getUniqueId());
        if (inviter == null) { p.sendMessage(msg("noInvite")); return true; }
        p.sendMessage(msg("noInvite")); // invite already cancelled
        return true;
    }

    private boolean doLeave(Player p) {
        if (!isMember(p.getUniqueId())) { p.sendMessage(msg("notInParty")); return true; }
        UUID leader = leaderOf(p.getUniqueId());
        Set<UUID> m = parties.get(leader);
        if (m != null) m.remove(p.getUniqueId());
        memberOf.remove(p.getUniqueId());
        broadcast(leader, msg("leftBroadcast", "player", p.getName()));
        p.sendMessage(msg("left"));
        return true;
    }

    private boolean doDisband(Player p) {
        if (isMember(p.getUniqueId())) { p.sendMessage(msg("notLeader")); return true; }
        if (!parties.containsKey(p.getUniqueId())) { p.sendMessage(msg("notInParty")); return true; }
        broadcast(p.getUniqueId(), msg("disbanded"));
        destroyParty(p.getUniqueId());
        return true;
    }

    private boolean doTransfer(Player p, String[] args) {
        Player t = target(args);
        if (t == null) { p.sendMessage(msg("noPlayer")); return true; }
        if (isMember(p.getUniqueId())) { p.sendMessage(msg("notLeader")); return true; }
        if (!parties.containsKey(p.getUniqueId())) { p.sendMessage(msg("notInParty")); return true; }
        if (!leaderOf(t.getUniqueId()).equals(p.getUniqueId())) {
            p.sendMessage(msg("notInSameParty")); return true;
        }
        Set<UUID> m = parties.remove(p.getUniqueId());
        m.remove(t.getUniqueId());
        m.add(p.getUniqueId());
        parties.put(t.getUniqueId(), m);
        for (UUID u : m) memberOf.put(u, t.getUniqueId());
        memberOf.remove(t.getUniqueId());
        broadcast(t.getUniqueId(), msg("transferred", "player", t.getName()));
        return true;
    }

    private boolean doPromote(Player p, String[] args) {
        Player t = target(args);
        if (t == null) { p.sendMessage(msg("noPlayer")); return true; }
        if (isMember(p.getUniqueId())) { p.sendMessage(msg("notLeader")); return true; }
        if (!leaderOf(t.getUniqueId()).equals(p.getUniqueId())) {
            p.sendMessage(msg("notInSameParty")); return true;
        }
        broadcast(p.getUniqueId(), msg("promoted", "player", t.getName()));
        return true;
    }

    /** The leader removes a member from the party. */
    private boolean doKick(Player p, String[] args) {
        Player t = target(args);
        if (t == null) { p.sendMessage(msg("noPlayer")); return true; }
        if (isMember(p.getUniqueId())) { p.sendMessage(msg("notLeader")); return true; }
        if (!leaderOf(t.getUniqueId()).equals(p.getUniqueId())) {
            p.sendMessage(msg("notInSameParty")); return true;
        }
        java.util.Set<java.util.UUID> m = parties.get(p.getUniqueId());
        if (m != null) m.remove(t.getUniqueId());
        memberOf.remove(t.getUniqueId());
        broadcast(p.getUniqueId(), msg("kicked", "player", t.getName()));
        return true;
    }

    private boolean doList(Player p) {
        UUID leader = leaderOf(p.getUniqueId());
        List<Player> all = partyPlayers(leader);
        p.sendMessage(msg("listHeader", "size", all.size()));
        for (Player m : all) p.sendMessage(msg("listEntry", "player", m.getName()));
        return true;
    }

    private boolean partyChat(Player p, String[] args) {
        if (args.length == 0) { p.sendMessage(msg("usage")); return true; }
        UUID leader = leaderOf(p.getUniqueId());
        if (leader.equals(p.getUniqueId()) && !parties.containsKey(p.getUniqueId())) {
            p.sendMessage(msg("notInParty")); return true;
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < args.length; i++) {
            if (i > 0) sb.append(' ');
            sb.append(args[i]);
        }
        broadcast(leader, msg("chatFormat", "player", p.getName(), "message", sb.toString()));
        return true;
    }
}
