// patterns.js — the pattern registry. This is data, not logic: the dashboard edits it.
//
// WHY THIS FILE MATTERS: the outgoing commands are operator-configurable, so "did it work?"
// can never be decided by the command name. It is decided by matching the server's REPLY.
// Every string below is therefore either captured off a live server or quoted from plugin
// source — never invented.
//
// PROVENANCE TAG
//   [LIVE]  captured verbatim off PaperSpigot 1.8.8-445 + AuthMe 5.6.0 on 2026-09-22,
//           port 25566, via minecraft-protocol 1.68.0 raw client evt 'chat'. Reproducible.
//   [SRC]   quoted from plugin source/tests by recon; not re-verified here.
//
// ANCHORING IS LOAD-BEARING. Public chat on this server flattens to "<Name> ..." and
// /me flattens to "* Name ...", so an unanchored /You are not in a party/ fires when a
// player merely types that sentence. Anchor with ^...$ and let typed chat pass through.
//
// COLOUR IS GONE BY MATCHING TIME: the engine matches on the flattened text, never on raw
// JSON. Every &-colour change splits a component into a separate extra[] child, so the raw
// JSON does not contain the whole sentence and no whole-sentence regex can match it.

const NAME = '[A-Za-z0-9_]{1,16}'
/** Plugin prefixes are per-plugin and configurable: PAF prepends "[Party] ", AlessioDP/Parties
 *  prepends nothing. Optional bracket group rather than baked into each pattern. */
// An optional plugin prefix. Two shapes are in the wild: a bracketed one ([Party] , the shape
// the reference plugin uses) and a bare word followed by a rule character (Party ▏ , measured
// on a live BedWars server). Matching only the bracketed form meant every pattern silently
// failed against the second, which reads exactly like a bot that cannot hear the server.
// ':' is deliberately NOT a separator - it is far too common inside messages.
const PFX = '(?:\\s*(?:\\[[^\\]]{1,16}\\]|[A-Za-z0-9_ -]{1,16}[▏│|¦»])\\s*)?'

export const PATTERNS = {
  // ---------------------------------------------------------------- transport / vanilla
  // [LIVE] off this exact server. Note it is the SPIGOT string, not vanilla's
  // "Unknown command. Try /help for a list of commands": CraftServer.dispatchCommand sends
  // spigot.yml messages.unknown-command whenever the label is unregistered. It contains NO
  // echo of the offending command, which is why commands must be issued one at a time.
  unknownCommand: { re: '^Unknown command\\. Type "/help" for help\\.$', kind: 'error', src: '[LIVE] spigot.yml messages.unknown-command' },
  // [LIVE] the long Bukkit variant. Reached here for /gamemode 1 on a non-op.
  // The vanilla short form "You do not have permission to use this command" is shipped too,
  // because which one fires depends on whether the command is a plugin or a vanilla wrapper.
  noPermissionBukkit: { re: '^I\'m sorry, but you do not have permission to perform this command\\. Please contact the server administrators if you believe that this is in error\\.$', kind: 'error', src: '[LIVE] org.bukkit.command.Command#testPermission' },
  noPermissionVanilla: { re: '^You do not have permission to use this command$', kind: 'error', src: '[SRC] commands.generic.permission' },
  // [LIVE] measured on a BedWars server: "Party ▏ PartyMaster is currently not online."
  // A missing player is a hard FAILED, not silence. It was reported as NO_RESPONSE for exactly
  // as long as this alternative was missing, which is the worst reading of the three.
  unknownPlayer: { re: '^That player cannot be found$|^Can\'t find player |^The player .+ has not been found$|is currently not online\\.?$|is not online\\.?$', kind: 'error', src: '[SRC] commands.generic.player.notFound + variants' },
  usage: { re: '^Usage: .+$', kind: 'error', src: '[SRC] commands.generic.usage' },
  // [LIVE] vanilla login-state disconnect. Means you are already connected under this name.
  // Arrives on the login-state 'disconnect' packet (0x00), NOT on play-state kick_disconnect.
  sameUsername: { re: '^The same username is already playing on the server!$', kind: 'error', src: '[LIVE] PlayerList duplicate-login check' },
  serverFull: { re: '^The server is full!$|^Server is full', kind: 'error', src: '[SRC] PlayerList' },
  // [LIVE] AuthMe repeats its limbo lines every messageInterval (5 s) while unauthenticated.
  // These are NOISE: they must never be counted as a command reply. Treating the repeat as a
  // new event makes a stalled bot look like a bot that keeps asking for help.
  accountListNoise: { re: '^You own \\d+ accounts?:$|^[a-z0-9_]+, [a-z0-9_]+', kind: 'noise', src: '[LIVE] AuthMe async-join limbo message' },
  welcomeNoise: { re: '^Welcome .+ on .+ server$|^This server uses AuthMeReloaded protection!$', kind: 'noise', src: '[LIVE] AuthMe welcome.txt' },
  joinLeaveNoise: { re: '^' + NAME + ' (joined|left) the game\\.$', kind: 'noise', src: '[LIVE] vanilla join/leave' },

  // ------------------------------------------- McbotctlParty (the reference plugin in plugin/)
  // [SRC] plugin/config.yml of this very plugin. The '[Party] ' prefix is handled by PFX.
  // These are the defaults for the ORIGINAL wording. If the operator renames a command or changes a message
  // in plugin/config.yml then it must be fixed up in the dashboard — exactly as designed.
  mbpInviteSent:      { re: '^' + PFX + NAME + ' was invited to your party\\.$', kind: 'ok', src: '[SRC] inviteSent' },
  mbpInviteReceived:  { re: '^' + PFX + 'You were invited into (?<inviter>' + NAME + ')\'s party!', kind: 'ok', src: '[SRC] inviteReceived' },
  mbpJoined:          { re: '^' + PFX + 'You joined (?<leader>' + NAME + ')\'s party!$', kind: 'ok', src: '[SRC] joined' },
  mbpJoinedBroadcast: { re: '^' + PFX + 'The player (?<joiner>' + NAME + ') joined the party\\.$', kind: 'ok', src: '[SRC] joinedBroadcast' },
  mbpYouLeft:         { re: '^' + PFX + 'You left your party\\.$', kind: 'ok', src: '[SRC] left' },
  mbpLeftBroadcast:   { re: '^' + PFX + 'The player (?<leaver>' + NAME + ') has left the party\\.$', kind: 'ok', src: '[SRC] leftBroadcast' },
  mbpDisbanded:       { re: '^' + PFX + 'The party has been disbanded\\.$', kind: 'ok', src: '[SRC] disbanded' },
  mbpTransferred:     { re: '^' + PFX + 'The new party leader is (?<leader>' + NAME + ')$', kind: 'ok', src: '[SRC] transferred' },
  mbpPromoted:        { re: '^' + PFX + NAME + ' has been promoted\\.$', kind: 'ok', src: '[SRC] promoted' },
  // [LIVE] The line a bot must recognise to know it has been invited - the signal the member
  // acts on by itself, rather than being told to accept. Several shapes exist; the group that
  // matched is picked out by number in the behaviour, so this stays one entry an operator can
  // override in one place. Add your server's wording here if none of these match.
  partyInviteToMe: { re: '^' + PFX + '(?:You were invited into (' + NAME + ')\'s party'
      + '|(' + NAME + ') has invited you to join'
      + '|You have been invited to join (' + NAME + ')\'s party'
      + '|(' + NAME + ') invited you to join'
      + '|(' + NAME + ') has invited you into their party)', kind: 'ok', src: '[LIVE] invite shapes' },

  mbpOfflineSelf:    { re: '^' + PFX + 'You are now marked offline', kind: 'ok', src: '[SRC] offlineSelf' },
  mbpOfflineParty:   { re: '^' + PFX + 'The player (?<player>' + NAME + ') is now offline\\.$', kind: 'ok', src: '[SRC] offlineParty' },
  mbpKicked:         { re: '^' + PFX + 'The player (?<kicked>' + NAME + ') has been removed from the party\\.$', kind: 'ok', src: '[SRC] kicked' },
  // Two DIFFERENT lines share a prefix. They mean different things and must not be conflated:
  //   notInParty -> this bot is not in a party (clears its membership)
  //   noInvite   -> there is no PENDING INVITE (the bot may well already be in a party)
  // Matching the shared prefix made a member who ran /p deny look like a member who had left.
  // [LIVE] the party-status panel of a BedWars server. The tracker could not read this shape
  // at all, so a bot that was demonstrably in a party (the server printed its owner) still
  // showed as 'not in party' on the dashboard.
  partyOwnerLine: { re: '^' + PFX + 'Owner:\\s*(?<leader>' + NAME + ')\\s*$', kind: 'ok', src: '[LIVE] live BedWars party panel' },
  partyHeader:    { re: '^' + PFX + 'Your Party\\s*$', kind: 'ok', src: '[LIVE] live BedWars party panel' },
  partyNoMembers: { re: '^' + PFX + 'Members:\\s*Nobody', kind: 'ok', src: '[LIVE] live BedWars party panel' },
  alreadyOnServer: { re: '^You are already connected to this server!?$', kind: 'ok', src: '[LIVE] lobby selector' },
  mbpNotInParty:      { re: '^' + PFX + 'You are not in a party\\.$', kind: 'error', src: '[SRC] notInParty' },
  mbpNoInvite:        { re: '^' + PFX + 'You are not in a party and have no pending invite\\.$', kind: 'error', src: '[SRC] noInvite' },
  mbpNotLeader:       { re: '^' + PFX + 'You are not the party leader\\.$', kind: 'error', src: '[SRC] notLeader' },
  mbpNoPlayer:        { re: '^' + PFX + 'That player cannot be found$', kind: 'error', src: '[SRC] noPlayer' },
  mbpAlreadyInParty:  { re: '^' + PFX + 'The player ' + NAME + ' is already in a party\\.$', kind: 'error', src: '[SRC] alreadyInParty' },
  mbpAlreadyInvited:  { re: '^' + PFX + 'The player ' + NAME + ' is already invited into your party\\.$', kind: 'error', src: '[SRC] alreadyInvited' },

  // ---------------------------------------------------------------------- AuthMe 5.6.0
  // [LIVE] NOTE the comma: AuthMe ships "Please, login with the command: /login <password>".
  // /Please,\s*login/ matches; "please login" does not.
  loginRequired: { re: '^Please,\\s*login with the command:?\\s*/\\S*login\\b', kind: 'prompt', src: '[LIVE] messages_en.yml login.login_request' },
  registerRequired: { re: '^Please,\\s*register to the server with the command:?\\s*/\\S*register\\b', kind: 'prompt', src: '[LIVE] messages_en.yml registration.register_request' },
  loginSuccess: { re: '^(Successful login!|Successfully logged in|Logged-in due to Session Reconnection)$', kind: 'ok', src: '[LIVE] login.success' },
  registerSuccess: { re: '^Successfully registered!$', kind: 'ok', src: '[LIVE] registration.success' },
  // [LIVE] second /login on an already-authenticated connection. NOT a success.
  alreadyLoggedIn: { re: '^You\'re already logged in!$', kind: 'error', src: '[LIVE] error.logged_in' },
  alreadyRegistered: { re: '^You\'re already registered!$|^You are already registered', kind: 'error', src: '[LIVE] error.already_registered' },
  wrongPassword: { re: '^Wrong password!$', kind: 'error', src: '[LIVE] login.wrong_password (also the kick reason)' },
  notRegistered: { re: '^This user isn\'t registered!$', kind: 'error', src: '[LIVE] error.unregistered_user' },
  // Sent whenever ANY non-allowlisted command is issued pre-auth: the command was cancelled,
  // not executed. Distinct from unknownCommand and much more likely in this project.
  authRequired: { re: '^In order to (use this command|chat) you must be authenticated!$', kind: 'error', src: '[LIVE] error.denied_command / denied_chat' },
  loginTimeout: { re: '^Login timeout exceeded, you have been kicked from the server, please try again!$', kind: 'error', src: '[LIVE] login.timeout_error' },
  quickCommand: { re: '^You used a command too fast!', kind: 'error', src: '[SRC] on_join_validation.quick_command — THE 1000 ms JOIN KICK' },
  antiBot: { re: '^AntiBot protection mode is enabled!', kind: 'error', src: '[SRC] antibot.kick_antibot' },
  captchaRequired: { re: '^To log in you have to solve a captcha code', kind: 'error', src: '[SRC] captcha.usage_captcha' },
  tempbanned: { re: '^You have been temporarily banned for failing to log in too many times\\.$', kind: 'error', src: '[SRC] error.tempban_max_logins' },
  minPasswordLength: { re: '^The chosen password .* (is not safe|is too short|Unsafety)', kind: 'error', src: '[SRC] password policy' },

  // ---------------------------------------------------------------- party plugins [SRC]
  // Seeds so the tool is useful before the operator finishes configuring. All overridable.
  // PartyAndFriends: prefix "[Party] " is prepended to every line INCLUDING errors.
  invitedBy: { re: '^' + PFX + 'You were invited into (?<inviter>' + NAME + ')\'s party!$', kind: 'ok', src: '[SRC] PAF Invite.YouWereInvitedBY' },
  inviteSent: { re: '^' + PFX + '(?<invitee>' + NAME + ') was invited to your party\\.$', kind: 'ok', src: '[SRC] PAF Invite.InvitedPlayer' },
  joinedParty: { re: '^' + PFX + 'The player (?<joiner>' + NAME + ') joined the party\\.$', kind: 'ok', src: '[SRC] PAF Join.PlayerHasJoined' },
  youJoined: { re: '^You (have )?joined (the party|(?<leader>' + NAME + ')\'s party)', kind: 'ok', src: '[SRC] PAF/AlessioDP join' },
  alreadyInParty: { re: '^' + PFX + '(You are already in a party!?|(?<player>' + NAME + ') is already in a party)$', kind: 'error', src: '[SRC] PAF/AlessioDP' },
  notInParty: { re: '^' + PFX + '(You need to be in a party\\.|You are not in a party!?)$', kind: 'error', src: '[SRC] PAF ErrorNoParty / AlessioDP not-in-party' },
  notLeader: { re: '^' + PFX + '(You are not the party leader\\.|You are not party leader\\.)$', kind: 'error', src: '[SRC] PAF ErrorNotPartyLeader' },
  partyPlayerOffline: { re: '^' + PFX + '(This player is not online\\.|Target player is invalid or offline\\.)$', kind: 'error', src: '[SRC] PAF ErrorPlayerNotOnline / bekvon' },
  alreadyInvited: { re: '^' + PFX + '(The player ' + NAME + ' is already invited into your party\\.|You already invited this player!)$', kind: 'error', src: '[SRC] PAF Invite.AlreadyInYourParty' },
  unknownSubcommand: { re: '^' + PFX + '(This command does not exist!|Invalid command)$', kind: 'error', src: '[SRC] PAF Error.CommandNotFound / AlessioDP invalid-command' },
  partyNoPermission: { re: '^' + PFX + '(You don\'t have the permission to execute this command!|You do not have access to that command)$', kind: 'error', src: '[SRC] PAF / AlessioDP' },
  partyDisbanded: { re: '^' + PFX + '(The party was dissolved because there are not enough players\\.|The party has been disbanded|Party disbanded|You left your party\\.)', kind: 'ok', src: '[SRC] PAF/AlessioDP/bekvon' },
  partyLeft: { re: '^' + PFX + '(?<leaver>' + NAME + ') (has left the party\\.|left the party)$', kind: 'ok', src: '[SRC] PAF General.PlayerHasLeftTheParty' },
  partyChat: { re: '^' + PFX + '(?<speaker>[^:]{1,64}?):\\s*(?<message>.*)$', kind: 'chat', src: '[SRC] PAF Chat.PartyChatOutput' }
}

/** Failure patterns applied to EVERY command, regardless of what the action's own
 *  `success` says. Without this a mistyped command classifies as NO_RESPONSE (timeout)
 *  instead of FAILED, and the operator loses the single clearest signal the tool has:
 *  "the server does not know this command". */
export const BASELINE_FAILURES = [
  'unknownCommand', 'noPermissionBukkit', 'noPermissionVanilla',
  'authRequired', 'notRegistered', 'wrongPassword', 'alreadyLoggedIn',
  'quickCommand', 'antiBot', 'captchaRequired', 'tempbanned',
  'loginTimeout', 'sameUsername', 'serverFull'
]

/** Noise is delivered on the bus (a reporter wants it) but never satisfies or fails a command. */
export const NOISE = ['accountListNoise', 'welcomeNoise', 'joinLeaveNoise']

export function compile (key) {
  const p = PATTERNS[key]
  if (!p) throw new Error(`unknown pattern "${key}"`)
  return Object.assign({ key }, p, { text: p.re, re: new RegExp(p.re) })
}

/** Accepts a registry key, a raw regex source, or an array of either. Built fresh per call so a
 *  dashboard edit takes effect without a restart. Bad sources are dropped with a warning rather
 *  than thrown: one malformed operator regex must not stop the fleet. */
export function toRegexList (spec, warn = () => {}) {
  const out = []
  for (const s of (Array.isArray(spec) ? spec : spec == null ? [] : [spec])) {
    if (s instanceof RegExp) { out.push({ key: String(s), re: s }); continue }
    const entry = PATTERNS[s]
    try {
      if (entry) out.push(compile(s))
      else out.push({ key: s, re: new RegExp(s) })
    } catch (e) { warn(`pattern rejected: ${s} (${e.message})`) }
  }
  return out
}
