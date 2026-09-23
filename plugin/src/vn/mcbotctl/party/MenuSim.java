package vn.mcbotctl.party;

import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.Material;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.block.Action;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.plugin.java.JavaPlugin;

import java.util.Arrays;

/**
 * Simulates the server-selector style GUI that real servers open from a hotbar item.
 *
 * This exists so the bot's GUI support can be verified against a KNOWN target: the item sits in
 * hotbar slot 5, a right-click opens a chest window, and exactly one slot in that window is the
 * "connect" button. Every click the plugin receives is logged with its raw slot, its row/column
 * and whether it was a right-click, so a bot that clicks the wrong place is obvious rather than
 * silently ignored.
 *
 * THE COORDINATES ARE 1-INDEXED, the way a player counts them: row 4, column 4 from the top. The
 * raw slot is (row-1)*9 + (col-1) = 30 for a chest. That off-by-one is the single easiest thing to
 * get wrong here, so both forms are logged.
 */
public class MenuSim implements Listener {

    public static final int HOTBAR_SLOT_INDEX = 4;          // the 5th hotbar slot, 0-indexed
    public static final int TARGET_ROW = 4;                 // 1-indexed, as a player counts
    public static final int TARGET_COL = 4;
    public static final int TARGET_SLOT = (TARGET_ROW - 1) * 9 + (TARGET_COL - 1);   // 30
    private static final String TITLE = "Server Selector";
    private static final String TAG = "[menu-sim] ";

    private final JavaPlugin holder;

    public MenuSim(JavaPlugin holder) { this.holder = holder; }

    private ItemStack named(Material m, String name, String... lore) {
        ItemStack it = new ItemStack(m);
        ItemMeta meta = it.getItemMeta();
        meta.setDisplayName(ChatColor.AQUA + name);
        if (lore.length > 0) meta.setLore(Arrays.asList(lore));
        it.setItemMeta(meta);
        return it;
    }

    @EventHandler
    public void onJoin(PlayerJoinEvent e) {
        Player p = e.getPlayer();
        // Clear the slot first: a leftover item from a previous session makes the test ambiguous.
        p.getInventory().setItem(HOTBAR_SLOT_INDEX, null);
        p.getInventory().setItem(HOTBAR_SLOT_INDEX,
                named(Material.COMPASS, "Server Selector", ChatColor.GRAY + "Right-click to open"));
        holder.getLogger().info(TAG + p.getName() + " given the menu item in hotbar slot " + (HOTBAR_SLOT_INDEX + 1));
    }

    @EventHandler
    public void onInteract(PlayerInteractEvent e) {
        if (e.getAction() != Action.RIGHT_CLICK_AIR && e.getAction() != Action.RIGHT_CLICK_BLOCK) return;
        ItemStack inHand = e.getItem();
        if (inHand == null || inHand.getType() != Material.COMPASS) return;
        e.setCancelled(true);
        Player p = e.getPlayer();
        Inventory menu = Bukkit.createInventory(p, 54, TITLE);
        // Row 1: a few decorations, so the grid is not uniform and a bot that clicks a fixed
        // position cannot pass by accident.
        menu.setItem(0, named(Material.REDSTONE_BLOCK, "Coming soon"));
        menu.setItem(1, named(Material.GRASS, "Survival"));
        for (int r = 0; r < 3; r++) menu.setItem(r * 9 + 4, named(Material.STAINED_GLASS_PANE, " "));
        menu.setItem(TARGET_SLOT, named(Material.BED, "BedWars",
                ChatColor.DARK_GRAY + "Minigame", ChatColor.YELLOW + "Click to connect"));
        p.openInventory(menu);
        holder.getLogger().info(TAG + p.getName() + " opened the menu; target slot is " + TARGET_SLOT
                + " (row " + TARGET_ROW + ", col " + TARGET_COL + ")");
    }

    @EventHandler
    public void onInventoryClick(InventoryClickEvent e) {
        String title = e.getView().getTitle();
        if (!TITLE.equals(title)) return;
        Player p = (Player) e.getWhoClicked();
        int raw = e.getRawSlot();
        int row = raw / 9 + 1, col = raw % 9 + 1;
        holder.getLogger().info(TAG + p.getName() + " clicked raw slot " + raw
                + " (row " + row + ", col " + col + ") button=" + e.getClick()
                + " right=" + e.isRightClick() + " shift=" + e.isShiftClick()
                + " window=" + e.getView().getType());
        // Top inventory only: a click in the player's own inventory is not a menu choice.
        if (raw < 0 || raw >= 54) return;
        e.setCancelled(true);
        if (raw == TARGET_SLOT) {
            p.closeInventory();
            p.sendMessage(ChatColor.GREEN + "BEDWARS JOINED");
            holder.getLogger().info(TAG + p.getName() + " SELECTED BedWars - target slot hit, right-click=" + e.isRightClick());
        } else {
            p.sendMessage(ChatColor.RED + "MENU WRONG SLOT " + raw);
        }
    }
}
