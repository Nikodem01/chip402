import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

Panel {
  id: root
  moduleName: "chip402"
  ipcTarget: "chip402"
  manageIpc: false

  property string focusSection: "header"
  property int ledgerIndex: 0
  property bool cursorActive: false
  property bool denialsExpanded: false
  property int phraseIndex: 0

  readonly property var activePhrases: [
    "Metering agents",
    "Counting chips",
    "Watching spend",
    "Guarding the cap",
    "Signing invoices",
    "Keeping receipts",
    "Allowing just enough",
    "Balancing books"
  ]
  readonly property string heroPhraseText: activePhrases[phraseIndex % activePhrases.length]
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color iconColor: chip402.active ? foreground : dim
  readonly property string toggleHint: chip402.paused ? "Let agents spend" : "Pause all agent spending"
  readonly property color barIconColor: chip402.active ? barForeground : Qt.darker(barForeground, 1.55)
  readonly property bool headerHasCursor: cursorActive && focusSection === "header"

  // The panel shows the receipt book. Blocked attempts collapse into one line and setting
  // changes move down beside the sliders that caused them; both stay in full in chip402 log.
  readonly property var ledgerRows: Model.visiblePayments(chip402.ledger)
  readonly property var denialsToday: Model.deniedToday(chip402.ledger)
  readonly property string denialSummaryText: Model.denialSummary(root.denialsToday)
  readonly property string auditSummaryText: Model.auditSummary(chip402.ledger)
  readonly property int shownRows: root.ledgerRows.length + (root.denialsExpanded ? root.denialsToday.length : 0)
  readonly property string hiddenLabelText: Model.hiddenLabel(Model.hiddenCount(chip402.ledger, root.shownRows))
  readonly property bool showLedger: ledgerRows.length > 0

  // Ordered top to bottom, so the cursor can walk the panel without a branch per pair.
  readonly property var navSections: {
    var out = ["header"]
    if (!chip402.ready) out.push("fund")
    if (chip402.configured) out.push("account")
    if (root.denialsToday.length > 0) out.push("denials")
    if (root.ledgerRows.length > 0) out.push("ledger")
    return out
  }
  // Conditions under which chip402 will refuse to spend even though nothing is paused. Caps
  // stay silent, but a refusal the user cannot see would just look like a broken plugin.
  readonly property string holdReason: {
    if (chip402.facilitatorError !== "") return "Facilitator unreachable — payments are held"
    if (chip402.feePayer === "" && chip402.configured) return "Payment sponsor unknown — payments are held"
    if (chip402.configured && !chip402.balanceFresh) return "Balance is stale — payments are held"
    if (chip402.floatWarning !== "") return chip402.floatWarning
    return ""
  }

  readonly property string remainingMicro: Model.remainingMicro(chip402.dailyCapMicro, chip402.spentTodayMicro)
  readonly property real spendRatio: Model.spendRatio(chip402.dailyCapMicro, chip402.spentTodayMicro)
  readonly property bool spendAlarming: spendRatio >= 0.85
  readonly property color track: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.18)
  readonly property color hoverFill: bar ? Style.hoverFillFor(bar.foreground, Color.accent) : "transparent"
  readonly property color selectedFill: bar ? Style.selectedFillFor(bar.foreground, Color.accent) : "transparent"
  readonly property int dailyIndex: Model.nearestIndex(Model.dailyMarks(), chip402.dailyCapMicro)
  readonly property int requestIndex: Model.nearestIndex(Model.requestMarks(), chip402.perRequestMicro)

  function heroMeta() {
    if (chip402.paused && chip402.configured) return "Agents cannot spend"
    if (root.holdReason !== "") return root.holdReason
    if (chip402.phase === "need_key") return "Create a local operator key"
    if (chip402.phase === "need_hbar") return "Send HBAR to open the account"
    if (chip402.phase === "completing") return "Putting the key on record"
    if (chip402.phase === "associating") return "Linking USDC to this account"
    if (chip402.phase === "need_usdc") return "Send testnet USDC to start"
    return root.heroPhraseText
  }

  function heroDetail() {
    if (chip402.paused && chip402.configured) return "PAUSED"
    if (chip402.phase === "need_usdc") return "0.00 USDC"
    if (chip402.phase !== "ready") return "SETUP"
    return Model.formatUsdShort(root.remainingMicro) + " left"
  }

  function setupTitle() {
    if (chip402.phase === "need_key") return "Create an operator key"
    if (chip402.phase === "need_hbar") return "Send a little HBAR"
    if (chip402.phase === "completing") return "Putting the key on record"
    if (chip402.phase === "associating") return "Linking USDC"
    if (chip402.phase === "need_usdc") return "Send testnet USDC"
    return "Top up this operator"
  }

  function setupSubtitle() {
    if (chip402.phase === "need_key") return "Unencrypted at ~/.config/chip402/key, mode 600. No passphrase — the caps are the limit."
    if (chip402.phase === "need_hbar") return chip402.evmAddress || "Waiting for the EVM address"
    if (chip402.phase === "completing") return "One cheap self-signed transaction, then it can pay"
    if (chip402.phase === "associating") return "Needs a little HBAR for the association fee"
    if (chip402.phase === "need_usdc") return (chip402.evmAddress || chip402.accountId) + " · Circle faucet, Hedera Testnet"
    return chip402.evmAddress
  }

  function setupAddress() {
    if (chip402.phase === "need_hbar" || chip402.phase === "need_key" || chip402.phase === "need_usdc") return chip402.evmAddress
    return chip402.accountId || chip402.evmAddress
  }

  function emptyLedgerText() {
    if (chip402.phase === "need_key") return "Create the operator key, then agents can settle x402 invoices here."
    if (chip402.phase === "need_hbar") return "Send HBAR so Hedera creates the account, then pay a 402."
    if (chip402.phase === "completing") return "The account has no key on record yet, so the facilitator would reject every payment. chip402 is fixing that."
    if (chip402.phase === "associating") return "Waiting for USDC association before payments can settle."
    if (chip402.phase === "need_usdc") return "Send testnet USDC, then try a Printwright model — see the README."
    return "No payments yet. Agents settle x402 invoices here."
  }

  function ensureCursor() {
    // A section can disappear under the cursor — the last payment ages out of the visible
    // slice, the day rolls over and today's denials empty. Fall back rather than point at it.
    if (root.navSections.indexOf(focusSection) < 0) focusSection = "header"
    if (ledgerIndex >= root.ledgerRows.length) ledgerIndex = Math.max(0, root.ledgerRows.length - 1)
    if (ledgerIndex < 0) ledgerIndex = 0
  }

  function moveCursor(dx, dy) {
    cursorActive = true
    ensureCursor()
    if (dy === 0) return
    // Inside the ledger the cursor walks rows first, and only leaves the section once it
    // runs off the top.
    if (focusSection === "ledger") {
      var next = ledgerIndex + dy
      if (next >= 0 && next < root.ledgerRows.length) {
        ledgerIndex = next
        scrollCursorIntoView()
        return
      }
      if (dy > 0) return
    }
    var at = root.navSections.indexOf(focusSection)
    if (at < 0) at = 0
    var target = at + dy
    if (target < 0 || target >= root.navSections.length) return
    focusSection = root.navSections[target]
    if (focusSection === "ledger") ledgerIndex = dy > 0 ? 0 : Math.max(0, root.ledgerRows.length - 1)
    if (focusSection === "header" && panelFlick) panelFlick.contentY = 0
    scrollCursorIntoView()
  }

  function setHeaderCursor() {
    cursorActive = true
    focusSection = "header"
    if (panelFlick) panelFlick.contentY = 0
  }

  function activateCursor() {
    ensureCursor()
    if (focusSection === "header") chip402.toggle()
    else if (focusSection === "fund") {
      if (chip402.phase === "need_key") chip402.runSetup()
      else chip402.copy(root.setupAddress())
    }
    else if (focusSection === "account") chip402.copy(chip402.accountId)
    else if (focusSection === "denials") root.denialsExpanded = !root.denialsExpanded
    else if (focusSection === "ledger") chip402.openHashscan(selectedLedger())
  }

  function selectedLedger() {
    if (root.ledgerRows.length === 0) return null
    return root.ledgerRows[Math.max(0, Math.min(ledgerIndex, root.ledgerRows.length - 1))]
  }

  function setLedgerCursor(index) {
    cursorActive = true
    focusSection = "ledger"
    ledgerIndex = index
    scrollCursorIntoView()
  }

  function scrollItemIntoView(item) {
    if (!panelFlick || !item) return
    Qt.callLater(function() {
      if (!item) return
      var margin = Style.space(6)
      var point = item.mapToItem(panelFlick.contentItem, 0, 0)
      var top = point.y
      var bottom = top + item.height
      var viewTop = panelFlick.contentY
      var viewBottom = viewTop + panelFlick.height
      var maxY = Math.max(0, panelFlick.contentHeight - panelFlick.height)
      if (top < viewTop + margin) panelFlick.contentY = Math.max(0, top - margin)
      else if (bottom > viewBottom - margin) panelFlick.contentY = Math.min(maxY, bottom + margin - panelFlick.height)
    })
  }

  function scrollCursorIntoView() {
    if (focusSection === "ledger" && ledgerColumn && ledgerIndex >= 0 && ledgerIndex < ledgerColumn.children.length) {
      scrollItemIntoView(ledgerColumn.children[ledgerIndex])
    }
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: if (opened) {
    cursorActive = false
    if (panelFlick) panelFlick.contentY = 0
    chip402.refresh()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }
  onLedgerIndexChanged: scrollCursorIntoView()

  Service {
    id: chip402
    settings: root.settings
  }

  Connections {
    target: chip402
    function onLedgerChanged() { root.ensureCursor() }
    function onConfiguredChanged() { root.ensureCursor() }
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { chip402.refresh(); return "ok" }
    function pause(): string { chip402.pause(); return "ok" }
    function resume(): string { chip402.resume(); return "ok" }
    function status(): string { return chip402.statusText }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    iconComponent: Component {
      Item {
        ChipIcon {
          anchors.centerIn: parent
          iconSize: Style.bar.iconCanvas
          color: root.barIconColor
          crossed: chip402.paused
          warning: !chip402.ready
        }
      }
    }
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton) chip402.toggle()
      else if (buttonCode === Qt.MiddleButton) chip402.refresh()
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    // Enough for the full panel — five receipts, the blocked line and both sliders — without
    // a scroll. fittedContentHeight still clamps to the screen, so this cannot overflow, and
    // a quieter day just makes the panel shorter.
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(680))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        if (!root.cursorActive) { root.cursorActive = true; return }
        root.moveCursor(dx, dy)
      }
      onActivateRequested: if (root.cursorActive) root.activateCursor()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if (t === "p" || t === "P") chip402.toggle()
        else if (t === "r" || t === "R") chip402.refresh()
        else if (t === "c" || t === "C") chip402.copy(chip402.accountId || chip402.evmAddress)
        else if (t === "f" || t === "F") chip402.openAccount()
      }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          width: panelFlick.width
          spacing: Style.space(12)

          Item {
            id: header
            width: parent.width
            implicitHeight: hero.implicitHeight
            readonly property bool ringVisible: root.headerHasCursor
            function focusHero() { root.setHeaderCursor() }

            PanelHero {
              id: hero
              width: parent.width
              title: "chip402"
              meta: root.heroMeta()
              detail: root.heroDetail()
              foreground: root.foreground
              fontFamily: root.fontFamily
              iconOpacity: chip402.active ? 1.0 : 0.5
              iconComponent: Component {
                ChipIcon {
                  iconSize: Style.font.display
                  color: root.iconColor
                  crossed: chip402.paused
                  warning: !chip402.ready
                }
              }
              trailingControl: Component {
                ToggleSwitch {
                  id: powerSwitch
                  checked: !chip402.paused && chip402.configured
                  busy: chip402.busy
                  interactive: chip402.configured
                  hasCursor: header.ringVisible
                  foreground: hero.foreground
                  onHovered: function(on) { if (on) header.focusHero() }
                  onToggled: chip402.toggle()

                  PanelToolTip {
                    visible: powerSwitch.containsMouse
                    text: root.toggleHint
                    fontFamily: hero.fontFamily
                  }
                }
              }
            }
          }

          Text {
            visible: chip402.actionStatus !== "" || chip402.displayError !== "" || root.holdReason !== ""
            width: parent.width
            text: chip402.actionStatus !== ""
              ? chip402.actionStatus
              : (chip402.displayError !== "" ? chip402.displayError : root.holdReason)
            color: (chip402.displayError !== "" || root.holdReason !== "") && chip402.actionStatus === ""
              ? root.urgent
              : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          SetupRow {
            visible: !chip402.ready
            width: parent.width
          }

          Column {
            visible: chip402.configured
            width: parent.width
            spacing: Style.spacing.labelGap

            InfoPair {
              label: "Balance"
              value: chip402.balanceFresh
                ? Model.formatUsd(chip402.balanceMicro)
                : Model.formatUsd(chip402.balanceMicro) + "  (stale)"
            }
            InfoPair {
              label: "In flight"
              visible: chip402.pendingMicro !== "0"
              value: Model.formatUsd(chip402.pendingMicro)
            }

            Column {
              width: parent.width
              spacing: Style.space(4)

              InfoPair {
                label: "Today"
                value: Model.formatUsdShort(chip402.spentTodayMicro) + " / " + Model.formatUsd(chip402.dailyCapMicro)
              }

              SpendMeter {
                width: parent.width
                value: root.spendRatio
                alarming: root.spendAlarming
              }
            }

            InfoPair { label: "Per request"; value: Model.formatUsd(chip402.perRequestMicro) }
            InfoPair {
              label: "Fee payer"
              value: chip402.feePayer !== "" ? chip402.feePayer : "not discovered — payments held"
            }

            AccountRow {
              width: parent.width
            }
          }

          PanelSeparator {
            foreground: root.foreground
          }

          Column {
            width: parent.width
            spacing: Style.space(10)

            PanelSectionHeader {
              text: "LEDGER"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Text {
              visible: root.ledgerRows.length === 0
              width: parent.width
              text: root.emptyLedgerText()
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              wrapMode: Text.WordWrap
              horizontalAlignment: Text.AlignHCenter
            }

            // A cap refusing a payment is chip402 working, so this is dim and counted rather
            // than a run of alarm-coloured rows. The urgent colour stays for the hold line.
            DenialSummary {
              visible: root.denialsToday.length > 0
              width: parent.width
            }

            Column {
              visible: root.denialsExpanded && root.denialsToday.length > 0
              width: parent.width
              spacing: Style.space(6)

              Repeater {
                model: root.denialsToday
                LedgerRow {
                  required property var modelData
                  width: parent.width
                  row: modelData
                  rowIndex: -1
                }
              }
            }

            Column {
              id: ledgerColumn
              visible: root.showLedger
              width: parent.width
              spacing: Style.space(6)

              Repeater {
                model: root.ledgerRows
                LedgerRow {
                  required property var modelData
                  required property int index
                  width: ledgerColumn.width
                  row: modelData
                  rowIndex: index
                }
              }
            }

            // Says how much the panel is not showing, and where the rest is. Without it the
            // trimming would read as "this is everything".
            Text {
              visible: root.hiddenLabelText !== ""
              width: parent.width
              text: root.hiddenLabelText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
            }
          }

          PanelSeparator {
            visible: chip402.configured
            foreground: root.foreground
          }

          Column {
            visible: chip402.configured
            width: parent.width
            spacing: Style.space(10)

            PanelSectionHeader {
              text: "LIMITS"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Text {
              width: parent.width
              text: "Daily cap  ·  " + Model.formatUsd(chip402.dailyCapMicro)
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            PanelSlider {
              width: parent.width
              bar: root.bar
              minimum: 0
              maximum: Model.dailyMarks().length - 1
              step: 1
              integer: true
              value: root.dailyIndex
              tickCount: Model.dailyMarks().length
              onReleased: function(v) {
                var marks = Model.dailyMarks()
                var idx = Math.max(0, Math.min(marks.length - 1, Math.round(v)))
                chip402.setDailyCap(marks[idx])
              }
            }

            Text {
              width: parent.width
              text: "Per request  ·  " + Model.formatUsd(chip402.perRequestMicro)
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            PanelSlider {
              width: parent.width
              bar: root.bar
              minimum: 0
              maximum: Model.requestMarks().length - 1
              step: 1
              integer: true
              value: root.requestIndex
              tickCount: Model.requestMarks().length
              onReleased: function(v) {
                var marks = Model.requestMarks()
                var idx = Math.max(0, Math.min(marks.length - 1, Math.round(v)))
                chip402.setPerRequestCap(marks[idx])
              }
            }

            // Raising a cap is the most privileged act in the system, so it stays visible —
            // beside the sliders that did it, not interleaved with payments at equal weight.
            Text {
              visible: root.auditSummaryText !== ""
              width: parent.width
              text: root.auditSummaryText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
            }
          }
        }
      }
    }
  }

  Timer {
    id: phraseTimer
    interval: 2800
    running: root.opened && chip402.active
    repeat: true
    onTriggered: phraseSwap.restart()
  }

  SequentialAnimation {
    id: phraseSwap
    PropertyAnimation {
      target: hero; property: "metaOpacity"
      to: 0.0; duration: 180; easing.type: Easing.OutQuad
    }
    ScriptAction {
      script: root.phraseIndex = (root.phraseIndex + 1) % root.activePhrases.length
    }
    PropertyAnimation {
      target: hero; property: "metaOpacity"
      to: 1.0; duration: 260; easing.type: Easing.InOutQuad
    }
  }

  component SetupRow: CursorSurface {
    id: fundRow
    hasCursor: root.cursorActive && root.focusSection === "fund"
    foreground: root.foreground
    implicitHeight: fundInner.implicitHeight + Style.spacing.rowPaddingX

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onEntered: {
        root.cursorActive = true
        root.focusSection = "fund"
      }
      onClicked: {
        if (chip402.phase === "need_key") chip402.runSetup()
        else chip402.copy(root.setupAddress())
      }
    }

    RowLayout {
      id: fundInner
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(8)
      spacing: Style.space(8)

      ColumnLayout {
        Layout.fillWidth: true
        spacing: Style.space(1)

        Text {
          Layout.fillWidth: true
          text: root.setupTitle()
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          elide: Text.ElideRight
        }

        Text {
          Layout.fillWidth: true
          text: root.setupSubtitle()
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideMiddle
        }
      }

      PanelActionButton {
        iconText: "󰆏"
        tooltipText: "Copy address"
        foreground: root.foreground
        fontFamily: root.fontFamily
        enabled: root.setupAddress() !== ""
        onClicked: chip402.copy(root.setupAddress())
      }

      PanelActionButton {
        visible: chip402.phase === "need_hbar" || chip402.phase === "completing" || chip402.phase === "associating"
        iconText: "󰌁"
        tooltipText: "Open faucet"
        foreground: root.foreground
        fontFamily: root.fontFamily
        onClicked: chip402.openUrl("https://portal.hedera.com/faucet")
      }

      PanelActionButton {
        visible: chip402.phase === "need_usdc"
        iconText: "󰌁"
        tooltipText: "Open Circle USDC faucet"
        foreground: root.foreground
        fontFamily: root.fontFamily
        onClicked: chip402.openUrl("https://faucet.circle.com/")
      }
    }
  }

  component SpendMeter: Item {
    id: meter
    property real value: 0
    property bool alarming: false
    property real thickness: Math.max(Style.space(4), Math.round(Style.spacing.controlHeight * 0.14))

    implicitHeight: thickness

    Rectangle {
      id: meterTrack
      anchors.fill: parent
      radius: height / 2
      color: root.track
    }

    Rectangle {
      anchors.left: meterTrack.left
      anchors.verticalCenter: meterTrack.verticalCenter
      height: meterTrack.height
      radius: meterTrack.radius
      width: meterTrack.width * Math.max(0, Math.min(1, meter.value))
      color: meter.alarming ? root.urgent : root.foreground

      Behavior on width {
        NumberAnimation { duration: 160; easing.type: Easing.OutCubic }
      }
    }
  }

  component AccountRow: CursorSurface {
    id: accountRow
    hasCursor: root.cursorActive && root.focusSection === "account"
    foreground: root.foreground
    implicitHeight: accountInner.implicitHeight + Style.spacing.rowPaddingX

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onEntered: {
        root.cursorActive = true
        root.focusSection = "account"
      }
      onClicked: chip402.copy(chip402.accountId)
    }

    RowLayout {
      id: accountInner
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(8)

      Text {
        text: "Account"
        color: root.foreground
        opacity: 0.6
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
      }

      Text {
        Layout.fillWidth: true
        text: chip402.accountId
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        elide: Text.ElideMiddle
        horizontalAlignment: Text.AlignRight
      }

      PanelActionButton {
        iconText: "󰆏"
        tooltipText: "Copy account"
        foreground: root.foreground
        fontFamily: root.fontFamily
        enabled: chip402.accountId !== ""
        onClicked: chip402.copy(chip402.accountId)
      }

      PanelActionButton {
        iconText: "󰌁"
        tooltipText: "Open on HashScan"
        foreground: root.foreground
        fontFamily: root.fontFamily
        enabled: chip402.accountId !== ""
        onClicked: chip402.openAccount()
      }
    }
  }

  component LedgerRow: CursorSurface {
    id: ledgerRow
    property var row: null
    // -1 for the expanded denials, which are read, not selected.
    property int rowIndex: 0
    readonly property bool blocked: ledgerRow.row !== null && ledgerRow.row.status === "denied"
    hasCursor: root.cursorActive && root.focusSection === "ledger" && rowIndex >= 0 && root.ledgerIndex === rowIndex
    foreground: root.foreground
    implicitHeight: ledgerContent.implicitHeight + Style.spacing.rowPaddingX

    MouseArea {
      anchors.fill: parent
      hoverEnabled: ledgerRow.rowIndex >= 0
      cursorShape: ledgerRow.rowIndex >= 0 ? Qt.PointingHandCursor : Qt.ArrowCursor
      enabled: ledgerRow.rowIndex >= 0
      onEntered: root.setLedgerCursor(ledgerRow.rowIndex)
      onClicked: chip402.openHashscan(ledgerRow.row)
    }

    RowLayout {
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(8)
      spacing: Style.space(8)

      Text {
        text: Model.ledgerGlyph(ledgerRow.row)
        color: ledgerRow.blocked ? root.dim : root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.icon
        Layout.alignment: Qt.AlignVCenter
      }

      ColumnLayout {
        id: ledgerContent
        Layout.fillWidth: true
        spacing: Style.space(1)

        RowLayout {
          Layout.fillWidth: true
          spacing: Style.space(8)

          Text {
            Layout.fillWidth: true
            text: Model.ledgerTitle(ledgerRow.row)
            color: ledgerRow.blocked ? root.dim : root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            elide: Text.ElideRight
          }

          Text {
            text: Model.ledgerTime(ledgerRow.row)
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            Layout.alignment: Qt.AlignRight | Qt.AlignVCenter
          }

          // Its own right-aligned column, so the money can be scanned straight down the
          // panel instead of landing at a different x on every row.
          // Not hidden when empty: a blocked row has no amount, and collapsing the slot
          // would slide its time out of the column the payments above it line up in.
          Text {
            text: Model.ledgerAmount(ledgerRow.row)
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            horizontalAlignment: Text.AlignRight
            Layout.minimumWidth: Style.space(76)
            Layout.alignment: Qt.AlignRight | Qt.AlignVCenter
          }
        }

        // Only rows with something unusual about them get a second line, so a routine
        // receipt stays one line and anything that is not routine gains weight by being two.
        Text {
          Layout.fillWidth: true
          visible: text !== ""
          text: Model.ledgerNote(ledgerRow.row)
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }
    }
  }

  component DenialSummary: CursorSurface {
    id: denialSummary
    hasCursor: root.cursorActive && root.focusSection === "denials"
    foreground: root.foreground
    implicitHeight: denialText.implicitHeight + Style.spacing.rowPaddingX

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onEntered: { root.cursorActive = true; root.focusSection = "denials" }
      onClicked: root.denialsExpanded = !root.denialsExpanded
    }

    RowLayout {
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(8)
      spacing: Style.space(8)

      Text {
        text: root.denialsExpanded ? "󰅀" : "󰅂"
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.icon
        Layout.alignment: Qt.AlignVCenter
      }

      Text {
        id: denialText
        Layout.fillWidth: true
        text: root.denialSummaryText
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        elide: Text.ElideRight
      }
    }
  }

  component InfoPair: Row {
    property string label: ""
    property string value: ""
    width: parent.width
    spacing: Style.space(8)
    Text {
      text: label
      color: root.foreground
      opacity: 0.6
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
    }
    Item {
      width: Math.max(0, parent.width - parent.children[0].implicitWidth - parent.children[2].implicitWidth - parent.spacing * 2)
      height: 1
    }
    Text {
      text: value
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
    }
  }
}
