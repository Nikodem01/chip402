import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// The bar item and its popup. Two interchangeable currency views over one pushed status frame,
// a set of preset chips that each cost a password, and one big red button that costs nothing.
//
// Nothing in this file *takes* authority. Pausing goes straight down the spend socket, which
// anyone running as me may do. Raising a limit or resuming does not: those go out as
// `pkexec chip402ctl …` and get a polkit password prompt, so the presets and the free-text field
// below can ask for a change but cannot make one. The panel is a mirror, a one-way kill switch,
// and a request form for everything else. The two limits it draws are the daemon's policy; the
// balance, what has gone out today and every payment row are the chain's, and the panel is told
// when they were last read so it can say so rather than show a stale number as a fresh one.
Panel {
  id: root
  moduleName: "chip402"
  ipcTarget: "chip402"

  // Which currency is on screen. Panel-local and never persisted: it is a view preference, not
  // policy, so every shell start opens on USDC and the protocol has no idea it exists.
  property string view: "usdc"
  property bool limitsOpen: false
  property bool topUpOpen: false

  // A reading was asked for by hand and the answer has not landed. Presentation only, and it lives
  // here rather than in Purse.qml because Purse.qml is the socket and nothing else. Without it a
  // press that the daemon drops — it drops a display reading taken seconds after the last one —
  // looks exactly like a press that did nothing, which is the failure that makes a refresh control
  // feel broken.
  property bool checking: false
  // `agoText` and `untilText` read the clock when they are evaluated, so nothing would make them
  // recompute between readings and the panel would freeze on whatever they said when it opened.
  // This is what re-evaluates them, once a second, and only while the popup is open — there is
  // nothing to redraw behind a closed one.
  property int ageTick: 0
  readonly property string chainAge: {
    root.ageTick;
    return purse.agoText(purse.confirmedAt)
  }
  readonly property string nextCheck: {
    root.ageTick;
    return purse.untilText(purse.nextReadAt)
  }

  readonly property var asset: purse.assetOf(root.view)
  readonly property var other: purse.assetOf(root.view === "usdc" ? "hbar" : "usdc")
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  // Mainnet is real money, so it is not a subtle badge — the bar itself changes colour and says
  // the network's name out loud.
  readonly property color accentColor: purse.mainnet ? (bar ? bar.urgent : Color.urgent) : foreground
  readonly property bool switchedOff: asset ? Number(asset.allowance) === 0 : false

  // One spacing scale, so the panel reads as a rhythm instead of as four arbitrary gaps: tight
  // within a line, a step between the rows of a group, a group between groups. Everything below
  // uses these three and nothing else.
  readonly property int tight: Style.space(4)
  readonly property int step: Style.space(8)
  readonly property int group: Style.space(16)
  // Money gets its own fixed column so every host starts on the same edge however long the
  // amount is. Left-aligned, so the payment rows share the left edge with everything above them.
  readonly property int amountColumn: Style.space(46)

  // The mark is always drawn, so the widget holds its slot even when there is nothing to report.
  // The label beside it always carries the selected currency's unit, so a glance is never
  // ambiguous about which of the two budgets it is looking at.
  //
  // It shows what is *left* to spend, not what has been spent. Money on a bar is read as money
  // you have — "$8.38" beside a wallet means eight dollars thirty-eight, not eight dollars gone
  // — and the number that matters at a glance is how long the leash still is. The popup carries
  // the spend against the allowance, where there is room to label it.
  readonly property string barLabel: {
    if (!purse.live) return ""
    if (purse.awaitingFunding) return "fund"
    if (purse.paused) return "paused"
    if (purse.keyMismatch) return "key?"
    // No number until the chain has given us one. A zero here would be a claim about money we
    // have not looked at, and the daemon refuses to pay in this state for the same reason.
    if (!purse.chainAnswered) return "…"
    if (!asset) return ""
    if (Number(asset.allowance) === 0) return "off"
    return purse.money(purse.remainingToday(asset), asset)
  }
  // BarIconButton picks the urgent colour for its own glyph when `active`; the icon component
  // replaces that glyph, so the same rule is restated here for the mark and the label.
  readonly property color barIconColor: purse.live && (purse.paused || purse.mainnet || purse.keyMismatch)
    ? (bar ? bar.urgent : Color.urgent)
    : (bar ? bar.barForeground : Color.foreground)

  // The bar draws the open-panel mark from this when a module paints something wider than a
  // single glyph; without it the mark is 55% of a slot that is mostly padding.
  readonly property real openPanelIndicatorWidth: content.implicitWidth

  function flip() { root.view = root.view === "usdc" ? "hbar" : "usdc" }

  // Perceived brightness, for deciding which theme colour is the paper and which is the ink.
  function luminance(c) { return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b }

  // "#rrggbb" or "#aarrggbb" down to the six hex digits qrencode wants.
  function hex(c) {
    var s = Qt.color(c).toString().replace("#", "")
    return s.length > 6 ? s.substring(s.length - 6) : s
  }

  Purse { id: purse }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // The bar item: the mark, and the selected currency's spend beside it. Built on WidgetButton
  // rather than BarIconButton because that one renders a single centred glyph in a fixed square
  // canvas — a mark plus a label is two things of unknown total width, so the slot has to be
  // measured from what is actually painted.
  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    // We paint our own content, so the built-in label is off and the button is told it has
    // something to show — otherwise it renders itself invisible.
    labelVisible: false
    hasVisualContent: true
    fixedWidth: vertical ? -1 : Math.round(content.implicitWidth + Style.spaceReal(8.5) * 2)
    fixedHeight: vertical ? Math.round(content.implicitHeight + Style.spaceReal(6) * 2) : -1
    // Dim when there is no daemon to talk to, and take the bar's urgent colour when the purse is
    // actually paused or — much more importantly — when this is mainnet and the money is real.
    // "No daemon" is not an alarm, so it stays dim rather than turning the bar red.
    dimmed: !purse.live
    active: purse.live && (purse.paused || purse.mainnet)
    tooltipText: purse.live
      ? (root.asset && !purse.paused && Number(root.asset.allowance) > 0
          ? qsTr("%1 left to spend today · %2").arg(purse.money(purse.remainingToday(root.asset), root.asset)).arg(purse.networkLabel)
          : purse.networkLabel + " · " + (purse.accountId === "" ? "not set up" : purse.accountId))
      : (purse.notPermitted ? qsTr("log out and back in to join the chip402 group") : qsTr("chip402 is not running"))
    onPressed: root.toggle()

    Row {
      id: content
      // Positioned rather than anchored: an anchor that silently fails to apply is how the
      // label ended up painting twenty pixels into the neighbouring widget.
      x: Math.round((parent.width - implicitWidth) / 2)
      y: Math.round((parent.height - implicitHeight) / 2)
      spacing: root.barLabel === "" ? 0 : Style.space(5)

      ChipIcon {
        anchors.verticalCenter: parent.verticalCenter
        width: Style.bar.iconCanvas
        height: Style.bar.iconCanvas
        color: root.barIconColor
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: root.barLabel !== ""
        textFormat: Text.PlainText
        text: root.barLabel
        color: root.barIconColor
        font.family: root.fontFamily
        font.pixelSize: Style.bar.iconFont
        renderType: Text.NativeRendering
      }
    }
  }

  KeyboardPanel {
    id: popup
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: popup.fittedContentWidth(Style.space(360))
    contentHeight: popup.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // Left and right flip the currency, which is the same gesture as clicking the header.
      onMoveRequested: function (dx) { if (dx !== 0) root.flip() }
      onCloseRequested: root.close()
      onTabRequested: function (direction) { root.switchPanel(direction) }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: root.group

        // ---------- Nothing to mirror yet ----------
        // Two different problems wear the same blank panel, and only one of them has a button:
        // a daemon that is not running can be started from here, and a session that predates
        // your chip402 group membership can only be fixed by logging in again.
        Column {
          visible: !purse.live
          width: parent.width
          spacing: root.step

          Text {
            width: parent.width
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            text: purse.notPermitted
              ? qsTr("chip402 is running, but this session started before you joined the chip402 group. Log out and back in.")
              : qsTr("chip402 is not running.")
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
          }

          // What the button is going to do, said before it is pressed rather than only in the
          // password dialog afterwards. Starting the daemon is the one privileged action here
          // that changes no limit, and a prompt is worth a sentence of warning either way: the
          // whole defence of a human-judgment boundary is that an unexpected dialog is
          // recognisable, and that needs you to know which ones to expect.
          Text {
            visible: purse.notRunning
            width: parent.width
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            text: qsTr("Starting it asks for your password. It changes no limit — the purse comes back exactly as you left it.")
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          Button {
            visible: purse.notRunning
            width: parent.width
            text: qsTr("START")
            fontSize: Style.font.bodySmall
            foreground: root.foreground
            fontFamily: root.fontFamily
            bordered: true
            onClicked: purse.startDaemon()
          }
        }

        // Before setup completes the address is the whole content, so the wallet can be funded
        // from a phone. It flips to the purse the moment the account exists.
        Column {
          visible: purse.awaitingFunding
          width: parent.width
          spacing: root.step

          PanelSectionHeader {
            text: qsTr("FUND THIS ADDRESS")
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          Funding { }
        }

        // ---------- Currency toggle ----------
        Row {
          visible: purse.live && !purse.awaitingFunding
          width: parent.width
          spacing: Style.space(6)

          Repeater {
            model: ["usdc", "hbar"]

            Button {
              required property var modelData
              readonly property var row: purse.assetOf(String(modelData))
              text: row ? String(row.symbol) : String(modelData).toUpperCase()
              fontSize: Style.font.bodySmall
              foreground: root.accentColor
              fontFamily: root.fontFamily
              bordered: true
              active: root.view === String(modelData)
              onClicked: root.view = String(modelData)
            }
          }

          Text {
            anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText
            text: purse.networkLabel
            color: purse.mainnet ? root.accentColor : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            font.bold: purse.mainnet
            font.letterSpacing: 1.2
          }
        }

        // ---------- What the chain last said ----------
        // Every figure below this line is the mirror node's, not ours, so the two states where
        // it has nothing to tell us are worth a line rather than a plausible-looking zero. Both
        // are also the daemon's reasons for refusing to pay, so the panel and the purse agree
        // about why nothing is happening.
        Text {
          visible: purse.live && !purse.awaitingFunding && !purse.chainAnswered
          width: parent.width
          textFormat: Text.PlainText
          wrapMode: Text.WordWrap
          text: qsTr("Waiting for the chain — nothing can be paid until it answers.")
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }

        Text {
          visible: purse.live && !purse.awaitingFunding && purse.inFlight > 0
          width: parent.width
          textFormat: Text.PlainText
          wrapMode: Text.WordWrap
          text: purse.inFlight === 1
            ? qsTr("One payment is settling. It already counts against today; nothing else is waiting on it.")
            : qsTr("%1 payments are settling. They already count against today; nothing else is waiting on them.").arg(purse.inFlight)
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }

        // ---------- Balance and today ----------
        Column {
          visible: purse.live && !purse.awaitingFunding && root.asset !== null && purse.chainAnswered
          width: parent.width
          spacing: root.tight

          Text {
            textFormat: Text.PlainText
            text: root.asset ? qsTr("%1 in the purse").arg(purse.money(root.asset.balance, root.asset)) : ""
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.title
            font.bold: true
          }

          // How old every figure below this is, and the way to ask for a fresher one — deliberately
          // the same control. What a refresh button is actually for is the reassurance that the
          // number is current, and a timestamp answers that outright where a button only answers it
          // by implication. It also makes the press legible: pressing a control that shows an age
          // has an obvious outcome, where pressing one labelled "refresh" and seeing nothing move
          // is indistinguishable from a panel that is broken.
          //
          // The line is not optional decoration. The daemon reads the chain when something happens
          // rather than on a clock, so a bare "12.40 USDC" could be a minute old or the whole
          // afternoon, and a figure with no age on it is a claim this panel cannot support.
          Item {
            width: parent.width
            implicitHeight: freshness.implicitHeight

            Row {
              id: freshness
              spacing: root.tight

              // The affordance. A pointer cursor is not one: it appears only once you are already
              // over the text, so it can only confirm a guess nobody had a reason to make. The
              // glyph is what says the line can be pressed before anybody presses it.
              Text {
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: "↻"
                color: refreshTap.containsMouse ? root.foreground : root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }

              Text {
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: root.checking ? qsTr("checking…") : root.chainAge
                color: refreshTap.containsMouse ? root.foreground : root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }

              // Kept dim and separate from the part that reacts to the pointer, because it is not
              // what the press does — pressing asks now, this says when nobody has to.
              Text {
                anchors.verticalCenter: parent.verticalCenter
                visible: !root.checking && root.nextCheck !== ""
                textFormat: Text.PlainText
                text: "· " + root.nextCheck
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }

            MouseArea {
              id: refreshTap
              anchors.fill: parent
              // Caption text is a small target for a pointer, so the hit area is grown past the
              // glyphs rather than the type being grown to meet the pointer.
              anchors.margins: -root.tight
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: {
                purse.refresh()
                root.checking = true
              }
            }
          }

          Item {
            width: parent.width
            implicitHeight: Style.space(8)

            Rectangle {
              id: track
              anchors.fill: parent
              radius: height / 2
              color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
            }

            Rectangle {
              anchors.left: track.left
              anchors.verticalCenter: track.verticalCenter
              height: track.height
              radius: track.radius
              color: purse.paused ? root.dim : root.accentColor
              width: Math.max(track.height, track.width * purse.spentFraction(root.asset))

              Behavior on width { NumberAnimation { duration: 280; easing.type: Easing.OutCubic } }
            }
          }

          Text {
            textFormat: Text.PlainText
            text: {
              if (!root.asset) return ""
              if (root.switchedOff) return qsTr("off")
              return purse.money(root.asset.spent, root.asset) + " / " + purse.money(root.asset.allowance, root.asset) + " · " + purse.resetsInText()
            }
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }
        }

        // ---------- Limits, collapsed by default ----------
        // The everyday job of this panel is glance-and-kill; adjusting is occasional, and eight
        // chips on every balance check is a settings screen wearing a status widget's clothes.
        Button {
          visible: purse.live && !purse.awaitingFunding
          text: (root.limitsOpen ? "⌄ " : "› ") + qsTr("Limits")
          fontSize: Style.font.bodySmall
          foreground: root.foreground
          fontFamily: root.fontFamily
          horizontalPadding: 0
          leftAlign: true
          onClicked: root.limitsOpen = !root.limitsOpen
        }

        Column {
          visible: root.limitsOpen && purse.live && !purse.awaitingFunding && root.asset !== null
          width: parent.width
          spacing: root.group

          LimitEditor {
            title: qsTr("DAILY ALLOWANCE")
            kind: "allowance"
            presets: root.asset ? root.asset.allowancePresets : []
            currentText: root.asset ? purse.money(root.asset.allowance, root.asset) : ""
          }

          LimitEditor {
            title: qsTr("MAX PER PAYMENT")
            kind: "max"
            presets: root.asset ? root.asset.maxPresets : []
            currentText: root.asset ? purse.money(root.asset.maxPayment, root.asset) : ""
          }
        }

        // Topping up is not a setup step you do once, it is a thing you do whenever the purse
        // runs low — so the address lives here permanently rather than vanishing after setup.
        Button {
          visible: purse.live && !purse.awaitingFunding
          text: (root.topUpOpen ? "⌄ " : "› ") + qsTr("Top up")
          fontSize: Style.font.bodySmall
          foreground: root.foreground
          fontFamily: root.fontFamily
          horizontalPadding: 0
          leftAlign: true
          onClicked: root.topUpOpen = !root.topUpOpen
        }

        Funding {
          visible: root.topUpOpen && purse.live && !purse.awaitingFunding
        }

        PanelSeparator {
          visible: purse.live && !purse.awaitingFunding && root.asset !== null
          foreground: root.foreground
        }

        // ---------- Payments, for this currency only ----------
        // Not a list the daemon keeps. Every row here is a transaction the mirror node returned
        // for this account since local midnight, so there is no row for a payment that did not
        // happen and no HashScan link that does not resolve. The daemon sends them newest first.
        Column {
          visible: purse.live && !purse.awaitingFunding && root.asset !== null
          width: parent.width
          spacing: root.tight

          Repeater {
            model: root.asset ? root.asset.payments.slice(0, 6) : []

            Item {
              id: receipt
              required property var modelData
              // Every row came off the chain with an id, so every row is a link.
              readonly property bool linkable: !!modelData.txId
              width: parent.width
              implicitHeight: line.implicitHeight + Style.space(5)

              Rectangle {
                anchors.fill: parent
                radius: Style.space(3)
                visible: hover.hovered && receipt.linkable
                color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.10)
              }

              HoverHandler {
                id: hover
                cursorShape: receipt.linkable ? Qt.PointingHandCursor : Qt.ArrowCursor
              }

              TapHandler {
                enabled: receipt.linkable
                onTapped: purse.openReceipt(receipt.modelData.txId)
              }

              Text {
                id: arrow
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                visible: receipt.linkable
                textFormat: Text.PlainText
                text: "↗"
                color: hover.hovered ? root.foreground : root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
              }

              Row {
                id: line
                anchors.left: parent.left
                anchors.right: arrow.left
                anchors.rightMargin: Style.space(6)
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(8)

                Text {
                  id: amount
                  width: root.amountColumn
                  textFormat: Text.PlainText
                  text: purse.money(receipt.modelData.amount, root.asset)
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                }

                Text {
                  width: Math.max(0, line.width - root.amountColumn - line.spacing)
                  textFormat: Text.PlainText
                  elide: Text.ElideRight
                  // The chain knows the counterparty as an account id; the host is our own label
                  // for it, written after we signed, and is decoration. When there is none — a
                  // payment made before this install, or by a `chip402 pay` we did not label —
                  // the account id is the honest thing to show.
                  text: receipt.modelData.host ? String(receipt.modelData.host) : String(receipt.modelData.payTo)
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                }
              }
            }
          }

          // Nothing today is a real answer, and it should read as one rather than as an empty
          // space that might be a bug.
          Text {
            visible: root.asset !== null && root.asset.payments.length === 0
            width: parent.width
            textFormat: Text.PlainText
            text: qsTr("nothing paid today")
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }
        }

        // ---------- Everything, from somewhere that is not this panel ----------
        // The list above is today, filtered to what the agent actually bought. This goes to the
        // whole account on a public explorer: every transaction, no filter and no host names,
        // because the names are chip402's own label for a counterparty the chain knows only as
        // 0.0.9584959. Deliberately a link rather than more rows in here — the panel's job is the
        // named, recent view, and "everything, ever" is a question better answered by a source
        // that is not us. There is no local log to read instead; that is the point of the rewrite.
        Text {
          visible: purse.live && !purse.awaitingFunding && purse.accountId !== ""
          width: parent.width
          textFormat: Text.PlainText
          text: qsTr("full history on HashScan ↗")
          color: historyHover.hovered ? root.foreground : root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption

          HoverHandler { id: historyHover; cursorShape: Qt.PointingHandCursor }
          TapHandler { onTapped: purse.openAccount() }
        }

        // ---------- The button ----------
        // Pause is one line on the spend socket: no prompt, no confirmation, instant. Resume
        // raises the polkit dialog. The asymmetry shows up as a different button, never as an
        // explanation printed at the user.
        Button {
          visible: purse.live && !purse.awaitingFunding
          width: parent.width
          text: purse.paused ? qsTr("RESUME") : qsTr("PAUSE")
          iconText: "⏻"
          iconSize: Style.font.title
          fontSize: Style.font.bodySmall
          foreground: purse.paused ? root.foreground : (root.bar ? root.bar.urgent : Color.urgent)
          fontFamily: root.fontFamily
          bordered: true
          onClicked: purse.paused ? purse.resume() : purse.pause()
        }
      }
    }
  }

  // Opening the popup is somebody asking, so it asks. Until this, the panel's only reading was the
  // one the daemon takes when the socket connects — which happens at login and then not again, so
  // an account topped up from a phone at nine could still be showing this morning's balance at two
  // with nothing on screen admitting it.
  onOpenedChanged: if (root.opened) purse.refresh()

  Timer {
    interval: 1000
    running: root.opened && purse.live
    repeat: true
    onTriggered: root.ageTick++
  }

  // While the top-up section is open somebody is standing at the screen waiting for money to
  // arrive, and money arriving is the one thing the daemon cannot notice by itself. Five seconds
  // is not a number chosen here: it is the floor the daemon already enforces on display readings,
  // so anything faster would be dropped and anything slower would be this file inventing a policy.
  //
  // Bounded by attention rather than by a deadline. The popup closes when it loses focus and this
  // stops with it, so there is no window to expire and no timer to get wrong. Excluded before
  // setup, where the same address is on screen but there is no account to read yet.
  Timer {
    interval: 5000
    running: root.opened && root.topUpOpen && purse.live && !purse.awaitingFunding
    repeat: true
    onTriggered: purse.refresh()
  }

  // A press is answered by a push, so the wait ends when the reading it asked for lands. The
  // fallback is for the press the daemon drops: no push follows, and without it the label would
  // sit on "checking…" for ever.
  Connections {
    target: purse
    function onConfirmedAtChanged() { root.checking = false }
  }

  Timer {
    interval: 4000
    running: root.checking
    onTriggered: root.checking = false
  }

  // Presets *and* a free-text amount. The ladder is there because pocket money is chosen
  // coarsely and one tap is one password prompt; the field is there because a ladder that suits
  // me is not a ladder that suits everyone, and the daemon validates the number regardless.
  //
  // Both rows are laid out on one five-column module, so the chips are all the same width and
  // the second row starts on the same left edge as the first. Ragged chip widths were the single
  // thing making this panel look busier than it is.
  component LimitEditor: Column {
    id: editor

    required property string title
    required property var presets
    // "allowance" or "max" — the two admin verbs this panel is allowed to ask for.
    required property string kind
    required property string currentText

    readonly property int columns: 5
    readonly property int gap: Style.space(6)
    readonly property int cell: Math.floor((width - gap * (columns - 1)) / columns)

    function apply(amount) {
      if (!purse.isValidAmount(amount, root.asset)) return
      if (editor.kind === "allowance") purse.setAllowance(root.view, amount)
      else purse.setMaxPayment(root.view, amount)
      custom.text = ""
      custom.focus = false
    }

    width: parent.width
    spacing: root.step

    // The label on the left, what it is set to on the right. A custom amount matches no preset
    // and would otherwise be invisible.
    Item {
      width: parent.width
      implicitHeight: heading.implicitHeight

      PanelSectionHeader {
        id: heading
        anchors.left: parent.left
        text: editor.title
        foreground: root.foreground
        fontFamily: root.fontFamily
      }

      Text {
        anchors.right: parent.right
        anchors.verticalCenter: heading.verticalCenter
        textFormat: Text.PlainText
        text: editor.currentText
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
    }

    Grid {
      width: parent.width
      columns: editor.columns
      spacing: editor.gap

      Repeater {
        model: editor.presets

        Button {
          required property var modelData
          readonly property string amount: String(modelData)
          width: editor.cell
          // "Off" is simply the first allowance preset, so it doubles as the asset toggle and
          // there is no separate enable control that could disagree with the number.
          text: amount === "0" ? qsTr("Off") : root.asset.prefix + amount
          fontSize: Style.font.bodySmall
          foreground: root.foreground
          fontFamily: root.fontFamily
          horizontalPadding: Style.space(2)
          bordered: true
          active: editor.currentText === root.asset.prefix + amount
          onClicked: editor.apply(amount)
        }
      }
    }

    // One cell for the amount and half a cell for the tick. A cell already holds "$10.00" with
    // room over, so anything wider was empty box; and the tick is one glyph, which wants to be
    // square rather than chip-shaped. Both edges land on the module's column lines, so the air
    // to the right reads as deliberate rather than as a row that ran out.
    Row {
      width: parent.width
      spacing: editor.gap

      TextField {
        id: custom
        width: editor.cell
        // The currency lives in the box rather than in what you type, so the field takes the
        // same bare number the presets are written as — and there is no "$" for the daemon's
        // parser to reject.
        foreground: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        leftPadding: affix.implicitWidth + Style.space(5)
        rightPadding: Style.space(4)
        verticalPadding: Style.spacing.controlPaddingY
        // Red while the text cannot possibly be accepted, so a typo never costs a password
        // prompt. Empty is not wrong, it is just empty.
        color: text === "" || purse.isValidAmount(text, root.asset) ? root.foreground : (root.bar ? root.bar.urgent : Color.urgent)
        onAccepted: editor.apply(text.trim())

        Text {
          id: affix
          anchors.left: parent.left
          anchors.leftMargin: Style.space(4)
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: root.asset ? root.asset.prefix : ""
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
        }
      }

      Button {
        width: Math.round(editor.cell / 2)
        horizontalPadding: 0
        text: "\u2713"
        fontSize: Style.font.bodySmall
        foreground: root.foreground
        fontFamily: root.fontFamily
        bordered: true
        onClicked: editor.apply(custom.text.trim())
      }
    }
  }

  // Where to send money, and the evidence that it is the right place. Used both before setup —
  // when it is the whole panel — and afterwards under "Top up".
  //
  // SECURITY: every string here came from the daemon, which derived the address from the key it
  // holds and then checked it against the chain. Nothing running as this user can change what is
  // displayed, because nothing running as this user can change either the key or the config the
  // daemon reads. That is the whole answer to "could something reroute my top-up": the address
  // is not a setting, it is a property of the key that would spend the money.
  component Funding: Column {
    id: funding

    // Which identifier the QR carries. There is no payment-request URI on Hedera — HashPack's
    // deeplinks are dApp-browser only, by their own security policy — so a scan cannot open a
    // wallet with the send screen prefilled. What it can do is fill the recipient once you are
    // already in Send → scan, and for that the payload has to be the identifier that wallet's
    // scanner parses. Hedera wallets read the account id; the faucet and EVM wallets want 0x.
    property string qrKind: "account"

    readonly property string address: purse.evmAddress === "" ? "" : "0x" + purse.evmAddress
    readonly property string qrValue: qrKind === "account" ? purse.accountId : address

    // A QR has to stay dark-modules-on-light to scan reliably, so rather than pick a polarity we
    // take whichever of the theme's two colours is lighter and use it as the paper. In a dark
    // theme that is the foreground; the code then sits on a card in the panel's own palette
    // instead of a raw white rectangle punched out of it.
    readonly property color paper: root.luminance(root.foreground) > root.luminance(Color.popups.background)
      ? root.foreground : Color.popups.background
    readonly property color ink: paper === root.foreground ? Color.popups.background : root.foreground

    // Value and colours are in the filename, so a switch of kind or theme never shows a cached
    // QR of the previous one.
    readonly property string qrPath: qrValue === ""
      ? ""
      : (Quickshell.env("XDG_RUNTIME_DIR") || "/tmp") + "/chip402-qr-" + qrKind + "-"
        + root.hex(ink) + root.hex(paper) + "-" + purse.evmAddress.substring(0, 10) + ".png"

    // The Image is pointed at the file only once qrencode has actually written it. Binding the
    // source straight to the path races the process and Qt caches the miss.
    property bool qrReady: false

    width: parent.width
    spacing: root.step

    // The argv is built here rather than bound declaratively: `command` is a binding like any
    // other, and setting `running` in the same tick that the value arrives fires qrencode with
    // whatever the binding held a moment ago — which, the first time round, is an empty string.
    function makeQr() {
      if (!visible || purse.accountVerified === false) return
      if (qrPath === "" || qrValue === "" || qrProcess.running) return
      qrReady = false
      qrProcess.command = ["qrencode", "-t", "PNG", "-o", qrPath, "-m", "1", "-s", "5",
                           "--foreground=" + root.hex(ink), "--background=" + root.hex(paper), qrValue]
      qrProcess.running = true
    }

    onVisibleChanged: makeQr()
    onQrPathChanged: makeQr()
    Component.onCompleted: makeQr()

    Process {
      id: qrProcess
      // argv, never a shell string. See makeQr for why command is assigned there.
      onExited: function (code) { funding.qrReady = code === 0 }
    }

    // SECURITY: on a definite mismatch the address is not shown at all. Money sent to an account
    // this key does not control is money nobody can move, so a QR is worse than nothing here —
    // the warning below takes its place. Only a positively-parsed, positively different key
    // reaches this state; "we could not tell" is `null` and still shows the address, because
    // hiding a working purse's top-up address over an unrecognised key shape would be the larger
    // failure. See readKeyMatch.
    Row {
      visible: purse.accountVerified !== false
      width: parent.width
      spacing: root.step

      Column {
        spacing: root.tight

        // The code sits on a rounded card of exactly the colour qrencode painted its background,
        // so the square corners of the PNG disappear into it and what is left is a card shaped
        // like every other surface in this panel.
        Rectangle {
          width: Style.space(108)
          height: width
          radius: Style.space(6)
          color: funding.paper

          Image {
            anchors.centerIn: parent
            width: parent.width - Style.space(10)
            height: width
            sourceSize.width: width * 3
            sourceSize.height: width * 3
            smooth: false
            cache: false
            visible: status === Image.Ready
            source: funding.qrReady ? "file://" + funding.qrPath : ""
          }
        }

        // Which network this code is only valid on. An account id means a *different* account on
        // every Hedera network, so this label is load-bearing rather than decoration.
        Text {
          width: Style.space(108)
          horizontalAlignment: Text.AlignHCenter
          textFormat: Text.PlainText
          text: purse.networkLabel
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
      }

      Column {
        width: parent.width - Style.space(108) - parent.spacing
        spacing: root.step

        Row {
          spacing: root.tight

          Button {
            text: qsTr("Account")
            fontSize: Style.font.caption
            foreground: root.foreground
            fontFamily: root.fontFamily
            bordered: true
            active: funding.qrKind === "account"
            onClicked: funding.qrKind = "account"
          }

          Button {
            text: qsTr("0x")
            fontSize: Style.font.caption
            foreground: root.foreground
            fontFamily: root.fontFamily
            bordered: true
            active: funding.qrKind === "evm"
            onClicked: funding.qrKind = "evm"
          }
        }

        // Both are shown with their own copy button, because a top-up from a laptop browser
        // never touches the QR — it is a paste into a faucet or an exchange.
        Copyable {
          width: parent.width
          label: qsTr("account")
          value: purse.accountWithChecksum === "" ? purse.accountId : purse.accountWithChecksum
        }

        Copyable {
          width: parent.width
          label: qsTr("address")
          value: funding.address
        }

        // The one honest thing this panel can say about its own address: go and look somewhere
        // that is not this panel. A "confirmed on chain" badge next to a QR would be assurance
        // about something you cannot see — you have no way to tell what the square encodes.
        Text {
          textFormat: Text.PlainText
          text: qsTr("verify on HashScan ↗")
          color: verifyHover.hovered ? root.foreground : root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption

          HoverHandler { id: verifyHover; cursorShape: Qt.PointingHandCursor }
          TapHandler { onTapped: purse.openAccount() }
        }
      }
    }

    // The chain's opinion, and the only state worth interrupting for: this key does not control
    // that account, so anything sent to either identifier above would be unspendable. The daemon
    // reads this three times a minute apart before it acts on it, so the wording changes when it
    // has — a warning that gates nothing and a refusal to pay are not the same sentence.
    Text {
      width: parent.width
      visible: purse.accountVerified === false
      textFormat: Text.PlainText
      wrapMode: Text.WordWrap
      text: purse.keyMismatch
        ? qsTr("This key does not control that account, so payment is refused. Do not send anything here — re-import it with `sudo chip402ctl setup --import`.")
        : qsTr("The chain says a different key controls that account. Do not send anything here; checking again.")
      color: root.bar ? root.bar.urgent : Color.urgent
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
  }

  component Copyable: Item {
    id: row

    required property string label
    required property string value
    property bool justCopied: false

    implicitHeight: Math.max(labelText.implicitHeight, valueText.implicitHeight)

    function take() {
      purse.copy(row.value)
      row.justCopied = true
      copiedFor.restart()
    }

    Timer {
      id: copiedFor
      interval: 1200
      onTriggered: row.justCopied = false
    }

    HoverHandler { id: copyHover; cursorShape: Qt.PointingHandCursor }
    TapHandler { onTapped: row.take() }

    Text {
      id: labelText
      anchors.left: parent.left
      anchors.top: parent.top
      textFormat: Text.PlainText
      text: row.label
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }

    // The affordance has to be visible: topping up from a laptop is a copy-and-paste, and a
    // tap target nobody can see is a tap target nobody uses.
    Text {
      id: copyMark
      anchors.right: parent.right
      anchors.top: parent.top
      textFormat: Text.PlainText
      text: row.justCopied ? "✓" : "⧉"
      color: row.justCopied ? root.foreground : (copyHover.hovered ? root.foreground : root.dim)
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
    }

    Text {
      id: valueText
      anchors.left: labelText.right
      anchors.leftMargin: root.step
      anchors.right: copyMark.left
      anchors.rightMargin: root.tight
      textFormat: Text.PlainText
      // Wrapped, never elided: the middle of an address is exactly where a substitution hides.
      wrapMode: Text.WrapAnywhere
      text: row.value
      color: copyHover.hovered ? root.foreground : root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
    }
  }
}
