package vn.mcbotctl.party;

import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Item;
import org.bukkit.entity.Player;
import org.bukkit.entity.Villager;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.player.PlayerInteractEntityEvent;
import org.bukkit.event.player.PlayerMoveEvent;
import org.bukkit.event.player.PlayerPickupItemEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitTask;
import org.bukkit.util.Vector;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * A small, opt-in BedWars fixture. /bwtest gives each player a separate lane; it does not change
 * the selector or party flow. The server drops iron, presents a decoy NPC and a two-page shop,
 * takes 16 ingots, gives wool and records arrival beyond an eight-block gap.
 */
public class BedWarsSim implements Listener, CommandExecutor {
    private static final String DECOY_TITLE = "Team Upgrades";
    private static final String ROOT_TITLE = "Travel Ledger";
    private static final String BLOCKS_TITLE = "Supply Crate";
    public static final int IRON_PRICE = 16;
    public static final int WOOL_COUNT = 64;
    private static final int Y = 120;             // player feet; platforms are at Y - 1
    private static final int TARGET_Z = 13;       // home ends at +4; +5..+12 are air
    private static final int LANE_SPACING = 32;

    private final JavaPlugin plugin;
    private final Map<UUID, Arena> arenas = new HashMap<UUID, Arena>();
    private final Map<UUID, Integer> lanes = new HashMap<UUID, Integer>();
    private int nextLane = 0;
    private int nextFixtureRound = 0;

    private static class Arena {
        final World world;
        final int x;
        final int z;
        final int blocksSlot;
        final int woolSlot;
        final List<Item> drops = new ArrayList<Item>();
        Villager shop;
        Villager decoy;
        BukkitTask generator;
        boolean reached;

        Arena(World world, int x, int z, int fixtureRound) {
            this.world = world;
            this.x = x;
            this.z = z;
            // Slots vary across fixture runs and are deliberately absent from /bwtest's response.
            this.blocksSlot = 12 + ((fixtureRound * 5) % 13);
            this.woolSlot = 18 + ((fixtureRound * 7) % 19);
        }

        Location generatorLocation() { return new Location(world, x + 0.5, Y + 0.3, z + 0.5); }
        Location shopLocation() { return new Location(world, x - 2.5, Y, z + 1.5); }
        Location decoyLocation() { return new Location(world, x + 2.5, Y, z + 0.5); }
    }

    public BedWarsSim(JavaPlugin plugin) { this.plugin = plugin; }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!(sender instanceof Player)) {
            sender.sendMessage("This command is for players only.");
            return true;
        }
        Player player = (Player) sender;
        if (command.getName().equalsIgnoreCase("bwtest")) {
            create(player);
            return true;
        }
        if (command.getName().equalsIgnoreCase("bwstatus")) {
            Arena arena = arenas.get(player.getUniqueId());
            if (arena == null) {
                player.sendMessage("BW STATUS no fixture; run /bwtest");
                return true;
            }
            player.sendMessage("BW STATUS iron=" + count(player, Material.IRON_INGOT)
                    + " wool=" + count(player, Material.WOOL)
                    + " reached=" + arena.reached
                    + " pos=" + player.getLocation().getBlockX() + ","
                    + player.getLocation().getBlockY() + "," + player.getLocation().getBlockZ());
            return true;
        }
        return false;
    }

    private void create(final Player player) {
        final UUID id = player.getUniqueId();
        cleanup(arenas.remove(id));
        Integer lane = lanes.get(id);
        if (lane == null) { lane = nextLane++; lanes.put(id, lane); }
        Location spawn = player.getWorld().getSpawnLocation();
        final Arena arena = new Arena(player.getWorld(), spawn.getBlockX() + 160 + lane * LANE_SPACING,
                spawn.getBlockZ() + 160, ++nextFixtureRound);
        arenas.put(id, arena);

        // Reset only this lane. The original menu item and party inventory are left alone; only
        // iron and wool from an earlier fixture attempt are removed from the player's inventory.
        for (int x = -5; x <= 5; x++) {
            for (int z = -5; z <= 22; z++) {
                for (int y = Y - 1; y <= Y + 5; y++) {
                    arena.world.getBlockAt(arena.x + x, y, arena.z + z).setType(Material.AIR);
                }
            }
        }
        for (int x = -4; x <= 4; x++) {
            for (int z = -4; z <= 4; z++) {
                arena.world.getBlockAt(arena.x + x, Y - 1, arena.z + z).setType(Material.STONE);
            }
            for (int z = TARGET_Z; z <= 21; z++) {
                arena.world.getBlockAt(arena.x + x, Y - 1, arena.z + z).setType(Material.STONE);
            }
        }
        arena.world.getBlockAt(arena.x, Y - 1, arena.z).setType(Material.IRON_BLOCK);
        arena.world.getBlockAt(arena.x + 2, Y - 1, arena.z).setType(Material.EMERALD_BLOCK);
        arena.world.getBlockAt(arena.x, Y - 1, arena.z + 17).setType(Material.GOLD_BLOCK);

        ItemStack[] contents = player.getInventory().getContents();
        for (int i = 0; i < contents.length; i++) {
            ItemStack item = contents[i];
            if (item != null && (item.getType() == Material.IRON_INGOT || item.getType() == Material.WOOL)) {
                player.getInventory().setItem(i, null);
            }
        }
        player.teleport(new Location(arena.world, arena.x + 0.5, Y, arena.z + 0.5, 0f, 0f));
        player.setFallDistance(0);
        player.setVelocity(new Vector(0, 0, 0));
        player.updateInventory();

        arena.shop = arena.world.spawn(arena.shopLocation(), Villager.class);
        arena.shop.setAdult();
        arena.shop.setProfession(Villager.Profession.LIBRARIAN);
        arena.shop.setCustomName(ChatColor.GOLD + "Traveler");
        arena.shop.setCustomNameVisible(true);
        arena.decoy = arena.world.spawn(arena.decoyLocation(), Villager.class);
        arena.decoy.setAdult();
        arena.decoy.setProfession(Villager.Profession.PRIEST);
        arena.decoy.setCustomName(ChatColor.GREEN + "Upgrade Shop");
        arena.decoy.setCustomNameVisible(true);
        arena.generator = Bukkit.getScheduler().runTaskTimer(plugin, new Runnable() {
            @Override public void run() { tick(player, arena); }
        }, 10L, 10L);

        player.sendMessage("BW TEST generator=" + arena.x + "," + Y + "," + arena.z
                + " bridge=" + arena.x + "," + Y + "," + (arena.z + 4)
                + " target=" + arena.x + "," + Y + "," + (arena.z + TARGET_Z)
                + " gap=8 ironPrice=" + IRON_PRICE);
        plugin.getLogger().info("[bw-test] " + player.getName() + " lane=" + lane + " generator="
                + arena.x + "," + Y + "," + arena.z + " targetZ=" + (arena.z + TARGET_Z)
                + " blocksSlot=" + arena.blocksSlot + " woolSlot=" + arena.woolSlot);
    }

    private void tick(Player player, Arena arena) {
        if (!player.isOnline() || arenas.get(player.getUniqueId()) != arena) return;
        if (arena.shop != null && arena.shop.isValid()
                && arena.shop.getLocation().distanceSquared(arena.shopLocation()) > 0.5) {
            arena.shop.teleport(arena.shopLocation());
        }
        if (arena.decoy != null && arena.decoy.isValid()
                && arena.decoy.getLocation().distanceSquared(arena.decoyLocation()) > 0.5) {
            arena.decoy.teleport(arena.decoyLocation());
        }
        if (player.getWorld() != arena.world) return;
        if (player.getLocation().distanceSquared(arena.generatorLocation()) > 2.25) return;
        if (count(player, Material.IRON_INGOT) >= IRON_PRICE) return;
        int pending = 0;
        for (Item item : arena.drops) if (item.isValid()) pending++;
        if (pending >= 2) return;
        Item iron = arena.world.dropItem(arena.generatorLocation(), new ItemStack(Material.IRON_INGOT, 1));
        iron.setPickupDelay(0);
        iron.setVelocity(new Vector(0, 0, 0));
        arena.drops.add(iron);
    }

    private static int count(Player player, Material material) {
        int total = 0;
        for (ItemStack item : player.getInventory().getContents()) {
            if (item != null && item.getType() == material) total += item.getAmount();
        }
        return total;
    }

    private static void takeIron(Player player, int amount) {
        ItemStack[] contents = player.getInventory().getContents();
        for (int i = 0; i < contents.length && amount > 0; i++) {
            ItemStack item = contents[i];
            if (item == null || item.getType() != Material.IRON_INGOT) continue;
            int taken = Math.min(item.getAmount(), amount);
            if (taken == item.getAmount()) player.getInventory().setItem(i, null);
            else { item.setAmount(item.getAmount() - taken); player.getInventory().setItem(i, item); }
            amount -= taken;
        }
    }

    @EventHandler
    public void onShopInteract(PlayerInteractEntityEvent event) {
        Player player = event.getPlayer();
        Arena arena = arenas.get(player.getUniqueId());
        if (arena == null) return;
        boolean realShop = arena.shop != null
                && arena.shop.getUniqueId().equals(event.getRightClicked().getUniqueId());
        boolean decoyShop = arena.decoy != null
                && arena.decoy.getUniqueId().equals(event.getRightClicked().getUniqueId());
        if (!realShop && !decoyShop) return;
        event.setCancelled(true);
        if (decoyShop) {
            Inventory upgrades = Bukkit.createInventory(player, 27, DECOY_TITLE);
            ItemStack sword = new ItemStack(Material.DIAMOND_SWORD, 1);
            ItemMeta swordMeta = sword.getItemMeta();
            swordMeta.setDisplayName(ChatColor.AQUA + "Sharpened Swords - 4 Diamonds");
            swordMeta.setLore(Arrays.asList(ChatColor.GRAY + "Team upgrade"));
            sword.setItemMeta(swordMeta);
            upgrades.setItem(13, sword);
            player.openInventory(upgrades);
            return;
        }
        Inventory shop = Bukkit.createInventory(player, 54, ROOT_TITLE);
        ItemStack blocks = new ItemStack(Material.SANDSTONE, 1);
        ItemMeta blocksMeta = blocks.getItemMeta();
        blocksMeta.setDisplayName(ChatColor.YELLOW + "Blocks");
        blocksMeta.setLore(Arrays.asList(ChatColor.GRAY + "Building supplies"));
        blocks.setItemMeta(blocksMeta);
        ItemStack weapons = new ItemStack(Material.DIAMOND_SWORD, 1);
        ItemMeta weaponsMeta = weapons.getItemMeta();
        weaponsMeta.setDisplayName(ChatColor.YELLOW + "Weapons");
        weaponsMeta.setLore(Arrays.asList(ChatColor.GRAY + "Combat equipment"));
        weapons.setItemMeta(weaponsMeta);
        shop.setItem(10, weapons);
        shop.setItem(arena.blocksSlot, blocks);
        player.openInventory(shop);
        player.sendMessage("BW SHOP OPEN");
    }

    private void openBlocks(Player player, Arena arena) {
        Inventory shop = Bukkit.createInventory(player, 54, BLOCKS_TITLE);
        ItemStack glass = new ItemStack(Material.STAINED_GLASS, 4);
        ItemMeta glassMeta = glass.getItemMeta();
        glassMeta.setDisplayName(ChatColor.WHITE + "Glass x4 - 12 Iron");
        glassMeta.setLore(Arrays.asList(ChatColor.GRAY + "Other building material"));
        glass.setItemMeta(glassMeta);
        shop.setItem(10, glass);
        ItemStack wool = new ItemStack(Material.WOOL, WOOL_COUNT, (short) 14);
        ItemMeta meta = wool.getItemMeta();
        meta.setDisplayName(ChatColor.WHITE + "Wool x" + WOOL_COUNT + " - " + IRON_PRICE + " Iron");
        meta.setLore(Arrays.asList(ChatColor.GRAY + "Click to buy", ChatColor.GRAY + "Cost: 16 Iron"));
        wool.setItemMeta(meta);
        shop.setItem(arena.woolSlot, wool);
        player.openInventory(shop);
        player.sendMessage("BW BLOCKS OPEN");
    }

    @EventHandler
    public void onShopClick(InventoryClickEvent event) {
        String title = event.getView().getTitle();
        if (!DECOY_TITLE.equals(title) && !ROOT_TITLE.equals(title) && !BLOCKS_TITLE.equals(title)) return;
        event.setCancelled(true);
        if (!(event.getWhoClicked() instanceof Player)) return;
        final Player player = (Player) event.getWhoClicked();
        final Arena arena = arenas.get(player.getUniqueId());
        if (arena == null) return;
        if (ROOT_TITLE.equals(title) && event.getRawSlot() == arena.blocksSlot) {
            // Opening a new inventory during InventoryClickEvent desynchronises some 1.8 clients.
            Bukkit.getScheduler().runTask(plugin, new Runnable() {
                @Override public void run() {
                    if (player.isOnline() && arenas.get(player.getUniqueId()) == arena) openBlocks(player, arena);
                }
            });
            return;
        }
        if (!BLOCKS_TITLE.equals(title) || event.getRawSlot() != arena.woolSlot) return;
        int iron = count(player, Material.IRON_INGOT);
        if (iron < IRON_PRICE) {
            player.sendMessage("BW NEED 16 IRON have=" + iron);
            return;
        }
        takeIron(player, IRON_PRICE);
        Map<Integer, ItemStack> overflow = player.getInventory().addItem(
                new ItemStack(Material.WOOL, WOOL_COUNT, (short) 14));
        for (ItemStack item : overflow.values()) player.getWorld().dropItem(player.getLocation(), item);
        player.updateInventory();
        // Closing a window from inside InventoryClickEvent can desynchronise a 1.8 client.
        Bukkit.getScheduler().runTask(plugin, new Runnable() {
            @Override public void run() {
                if (!player.isOnline()) return;
                player.closeInventory();
                player.sendMessage("BW BOUGHT WOOL " + WOOL_COUNT + " FOR " + IRON_PRICE + " IRON");
            }
        });
        plugin.getLogger().info("[bw-test] " + player.getName() + " bought " + WOOL_COUNT
                + " wool for " + IRON_PRICE + " iron");
    }

    @EventHandler
    public void onPickup(PlayerPickupItemEvent event) {
        Arena arena = arenas.get(event.getPlayer().getUniqueId());
        if (arena == null || !arena.drops.contains(event.getItem())) return;
        plugin.getLogger().info("[bw-test] " + event.getPlayer().getName() + " picked up iron"
                + " (inventory before pickup=" + count(event.getPlayer(), Material.IRON_INGOT) + ")");
    }

    @EventHandler
    public void onMove(PlayerMoveEvent event) {
        Arena arena = arenas.get(event.getPlayer().getUniqueId());
        if (arena == null || arena.reached || event.getTo() == null || event.getTo().getWorld() != arena.world) return;
        Location pos = event.getTo();
        if (pos.getBlockY() != Y || Math.abs(pos.getBlockX() - arena.x) > 4
                || pos.getBlockZ() < arena.z + TARGET_Z || pos.getBlockZ() > arena.z + 21) return;
        arena.reached = true;
        event.getPlayer().sendMessage("BW ISLAND REACHED");
        plugin.getLogger().info("[bw-test] " + event.getPlayer().getName() + " reached adjacent island");
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent event) {
        cleanup(arenas.remove(event.getPlayer().getUniqueId()));
    }

    private void cleanup(Arena arena) {
        if (arena == null) return;
        if (arena.generator != null) arena.generator.cancel();
        if (arena.shop != null && arena.shop.isValid()) arena.shop.remove();
        if (arena.decoy != null && arena.decoy.isValid()) arena.decoy.remove();
        for (Item item : arena.drops) if (item.isValid()) item.remove();
        arena.drops.clear();
    }

    public void dispose() {
        for (Arena arena : arenas.values()) cleanup(arena);
        arenas.clear();
    }
}
