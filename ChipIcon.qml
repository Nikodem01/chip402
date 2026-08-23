import QtQuick
import QtQuick.Effects
import qs.Commons
import qs.Ui

// Renders assets/chip.svg and recolors it to the bar/panel foreground.
// The SVG is the source of truth — do not redraw the mark in QML.
Item {
  id: root

  property real iconSize: Style.font.icon
  property color color: Color.foreground
  property color badgeColor: Color.urgent
  property bool crossed: false
  property bool warning: false

  width: iconSize
  height: iconSize
  implicitWidth: iconSize
  implicitHeight: iconSize

  Image {
    id: mark
    anchors.fill: parent
    source: Qt.resolvedUrl("assets/chip.svg")
    fillMode: Image.PreserveAspectFit
    sourceSize.width: Math.max(64, Math.round(width * 3))
    sourceSize.height: Math.max(64, Math.round(height * 3))
    visible: false
    layer.enabled: true
    asynchronous: false
  }

  MultiEffect {
    anchors.fill: mark
    source: mark
    colorization: 1.0
    colorizationColor: root.color
  }

  Rectangle {
    visible: root.crossed
    anchors.centerIn: parent
    width: parent.width * 1.18
    height: Math.max(2, parent.height * 0.14)
    radius: height / 2
    color: root.color
    rotation: -45
    z: 2
  }

  BorderSurface {
    visible: root.warning
    width: Math.max(7, parent.width * 0.42)
    height: width
    radius: width / 2
    color: root.badgeColor
    anchors.right: parent.right
    anchors.top: parent.top
    z: 3
    borderSpec: Border.flat(Color.popups.background, 1)

    Text {
      anchors.centerIn: parent
      text: "!"
      color: Color.background
      font.family: Style.font.family
      font.pixelSize: Math.max(6, parent.height * 0.72)
      font.bold: true
    }
  }
}
