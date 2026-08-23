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
  moduleName: "nikodem.allowance"
  ipcTarget: "nikodem.allowance"
  manageIpc: false

  property string focusSection: "header"
  property int ledgerIndex: 0
  property bool cursorActive: false
  property int phraseIndex: 0

  readonly property var activePhrases: [
    "Metering agents",
    "Counting tinybars",
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
  readonly property color iconColor: allowance.active ? foreground : dim
  readonly property string toggleHint: allowance.paused ? "Allow agents to spend" : "Pause all agent spending"
  readonly property color barIconColor: allowance.active ? barForeground : Qt.darker(barForeground, 1.55)
  readonly property bool headerHasCursor: cursorActive && focusSection === "header"
  readonly property bool showLedger: allowance.ledger.length > 0
  readonly property color hoverFill: bar ? Style.hoverFillFor(bar.foreground, Color.accent) : "transparent"
  readonly property color selectedFill: bar ? Style.selectedFillFor(bar.foreground, Color.accent) : "transparent"
  readonly property int dailyIndex: Model.nearestIndex(Model.dailyMarks(), allowance.dailyCapTinybars)
  readonly property int requestIndex: Model.nearestIndex(Model.requestMarks(), allowance.perRequestTinybars)

  function heroMeta() {
    if (!allowance.configured) return "Fund the operator to start"
    if (allowance.paused) return "Allowance paused"
    return root.heroPhraseText
  }

  function heroDetail() {
    if (!allowance.configured) return "SETUP"
    if (allowance.paused) return "PAUSED"
    return Model.formatHbarShort(allowance.balanceTinybars) + " ℏ"
  }

  function ensureCursor() {
    if (focusSection === "ledger" && allowance.ledger.length === 0) focusSection = "header"
    if (ledgerIndex >= allowance.ledger.length) ledgerIndex = Math.max(0, allowance.ledger.length - 1)
    if (ledgerIndex < 0) ledgerIndex = 0
  }

  function moveCursor(dx, dy) {
    cursorActive = true
    ensureCursor()
    if (dy === 0) return
    if (focusSection === "header") {
      if (dy > 0 && !allowance.configured) focusSection = "fund"
      else if (dy > 0 && allowance.ledger.length > 0) {
        focusSection = "ledger"
        ledgerIndex = 0
        scrollCursorIntoView()
      }
      return
    }
    if (focusSection === "fund") {
      if (dy < 0) setHeaderCursor()
      else if (allowance.ledger.length > 0) {
        focusSection = "ledger"
        ledgerIndex = 0
      }
      return
    }
    if (focusSection === "ledger") {
      if (dy < 0 && ledgerIndex === 0) {
        if (!allowance.configured) focusSection = "fund"
        else setHeaderCursor()
        return
      }
      ledgerIndex = Math.max(0, Math.min(allowance.ledger.length - 1, ledgerIndex + dy))
      scrollCursorIntoView()
    }
  }

  function setHeaderCursor() {
    cursorActive = true
    focusSection = "header"
    if (panelFlick) panelFlick.contentY = 0
  }

  function activateCursor() {
    ensureCursor()
    if (focusSection === "header") allowance.toggle()
    else if (focusSection === "fund") allowance.runSetup()
    else if (focusSection === "ledger") allowance.openHashscan(selectedLedger())
  }

  function selectedLedger() {
    if (allowance.ledger.length === 0) return null
    return allowance.ledger[Math.max(0, Math.min(ledgerIndex, allowance.ledger.length - 1))]
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
    allowance.refresh()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }
  onLedgerIndexChanged: scrollCursorIntoView()

  Service {
    id: allowance
    settings: root.settings
  }

  Connections {
    target: allowance
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
    function refresh(): string { allowance.refresh(); return "ok" }
    function pause(): string { allowance.pause(); return "ok" }
    function resume(): string { allowance.resume(); return "ok" }
    function status(): string { return allowance.statusText }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    iconComponent: Component {
      Item {
        AllowanceIcon {
          anchors.centerIn: parent
          iconSize: Style.space(12)
          color: root.barIconColor
          crossed: allowance.paused
          warning: !allowance.configured
        }
      }
    }
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton) allowance.toggle()
      else if (buttonCode === Qt.MiddleButton) allowance.refresh()
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
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(560))

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
        if (t === "p" || t === "P") allowance.toggle()
        else if (t === "r" || t === "R") allowance.refresh()
        else if (t === "c" || t === "C") allowance.copy(allowance.accountId || allowance.evmAddress)
        else if (t === "f" || t === "F") allowance.openAccount()
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
              title: "Allowance"
              meta: root.heroMeta()
              detail: root.heroDetail()
              foreground: root.foreground
              fontFamily: root.fontFamily
              iconOpacity: allowance.active ? 1.0 : 0.5
              iconComponent: Component {
                AllowanceIcon {
                  iconSize: Style.font.display
                  color: root.iconColor
                  crossed: allowance.paused
                  warning: !allowance.configured
                }
              }
              trailingControl: Component {
                ToggleSwitch {
                  id: powerSwitch
                  checked: !allowance.paused && allowance.configured
                  busy: allowance.busy
                  interactive: allowance.configured
                  hasCursor: header.ringVisible
                  foreground: hero.foreground
                  onHovered: function(on) { if (on) header.focusHero() }
                  onToggled: allowance.toggle()

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
            visible: allowance.actionStatus !== "" || allowance.lastError !== ""
            width: parent.width
            text: allowance.actionStatus !== "" ? allowance.actionStatus : allowance.lastError
            color: allowance.lastError !== "" && allowance.actionStatus === "" ? root.urgent : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          FundRow {
            visible: !allowance.configured
            width: parent.width
          }

          Column {
            visible: allowance.configured
            width: parent.width
            spacing: Style.spacing.labelGap

            InfoPair { label: "Balance"; value: Model.formatHbar(allowance.balanceTinybars) }
            InfoPair { label: "Today"; value: Model.formatHbar(allowance.spentTodayTinybars) + " / " + Model.formatHbar(allowance.dailyCapTinybars) }
            InfoPair { label: "Per request"; value: Model.formatHbar(allowance.perRequestTinybars) }
            InfoPair { label: "Account"; value: allowance.accountId }
          }

          PanelSeparator {
            visible: allowance.configured
            foreground: root.foreground
          }

          Column {
            visible: allowance.configured
            width: parent.width
            spacing: Style.space(10)

            PanelSectionHeader {
              text: "LIMITS"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Text {
              width: parent.width
              text: "Daily cap  ·  " + Model.formatHbar(allowance.dailyCapTinybars)
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
                allowance.setDailyCap(marks[idx])
              }
            }

            Text {
              width: parent.width
              text: "Per request  ·  " + Model.formatHbar(allowance.perRequestTinybars)
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
                allowance.setPerRequestCap(marks[idx])
              }
            }
          }

          PanelSeparator {
            visible: allowance.configured
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
              visible: allowance.ledger.length === 0
              width: parent.width
              text: allowance.configured ? "No payments yet. Try allowance fetch." : "Fund the operator, then pay a 402."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              wrapMode: Text.WordWrap
              horizontalAlignment: Text.AlignHCenter
            }

            Column {
              id: ledgerColumn
              visible: root.showLedger
              width: parent.width
              spacing: Style.space(6)

              Repeater {
                model: allowance.ledger
                LedgerRow {
                  required property var modelData
                  required property int index
                  width: ledgerColumn.width
                  row: modelData
                  rowIndex: index
                }
              }
            }
          }
        }
      }
    }
  }

  Timer {
    id: phraseTimer
    interval: 2800
    running: root.opened && allowance.active
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

  component FundRow: CursorSurface {
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
      onClicked: allowance.runSetup()
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
          text: allowance.evmAddress !== "" ? "Top up this operator" : "Create an operator key"
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          elide: Text.ElideRight
        }

        Text {
          Layout.fillWidth: true
          text: allowance.evmAddress !== "" ? allowance.evmAddress : "Generate a local Hedera key, then faucet it"
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
        enabled: allowance.evmAddress !== ""
        onClicked: allowance.copy(allowance.evmAddress)
      }

      PanelActionButton {
        iconText: "󰌁"
        tooltipText: "Open faucet"
        foreground: root.foreground
        fontFamily: root.fontFamily
        onClicked: allowance.openUrl("https://portal.hedera.com/faucet")
      }
    }
  }

  component LedgerRow: CursorSurface {
    id: ledgerRow
    property var row: null
    property int rowIndex: 0
    hasCursor: root.cursorActive && root.focusSection === "ledger" && root.ledgerIndex === rowIndex
    foreground: root.foreground
    implicitHeight: ledgerContent.implicitHeight + Style.spacing.rowPaddingX

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onEntered: root.setLedgerCursor(ledgerRow.rowIndex)
      onClicked: allowance.openHashscan(ledgerRow.row)
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
        color: (ledgerRow.row && ledgerRow.row.status === "denied") ? root.urgent : root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.icon
        Layout.alignment: Qt.AlignVCenter
      }

      ColumnLayout {
        id: ledgerContent
        Layout.fillWidth: true
        spacing: Style.space(1)

        Text {
          Layout.fillWidth: true
          text: Model.ledgerTitle(ledgerRow.row)
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          elide: Text.ElideRight
        }

        Text {
          Layout.fillWidth: true
          text: Model.ledgerMeta(ledgerRow.row)
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
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
