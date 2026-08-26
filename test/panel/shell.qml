import Quickshell
import QtQuick

// A harness for ui/Purse.qml. The test copies that file in beside this one — verbatim, so what
// runs is the shipping bytes — because Quickshell will not scan a module path outside its own
// config folder, and importing the whole ui/ directory would drag in Chip.qml's Omarchy imports.
//
// It prints one line per state change and nothing else: no bar, no popup, no theme.
ShellRoot {
  id: harness

  Purse {
    id: purse
    spendSocket: Quickshell.env("CHIP402_TEST_SOCK")

    onStatusChanged: console.warn("PANEL live=" + (status !== null) + " round=" + (status ? status.round : "-"))
    onSocketErrorChanged: console.warn("PANEL socketError=" + socketError)
  }

  // A heartbeat, so a test can tell "still disconnected" from "the harness died".
  Timer {
    interval: 1000
    running: true
    repeat: true
    onTriggered: console.warn("PANEL tick live=" + (purse.live ? 1 : 0) + " linked=" + (purse.linked ? 1 : 0))
  }
}
