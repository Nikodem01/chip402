import QtQuick
import qs.Commons
import qs.Ui

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

  // Stacked coins — reads as "metered money" at bar size without an SVG.
  Coin {
    width: root.iconSize * 0.72
    height: width * 0.34
    x: (root.iconSize - width) / 2
    y: root.iconSize * 0.18
    opacity: 0.45
  }
  Coin {
    width: root.iconSize * 0.82
    height: width * 0.34
    x: (root.iconSize - width) / 2
    y: root.iconSize * 0.36
    opacity: 0.75
  }
  Coin {
    width: root.iconSize * 0.90
    height: width * 0.36
    x: (root.iconSize - width) / 2
    y: root.iconSize * 0.54
    opacity: 1.0
  }

  Rectangle {
    visible: root.crossed
    anchors.centerIn: parent
    width: parent.width * 1.18
    height: Math.max(2, parent.height * 0.14)
    radius: height / 2
    color: root.color
    rotation: -45
  }

  BorderSurface {
    visible: root.warning
    width: Math.max(7, parent.width * 0.42)
    height: width
    radius: width / 2
    color: root.badgeColor
    anchors.right: parent.right
    anchors.bottom: parent.bottom
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

  component Coin: Rectangle {
    radius: height / 2
    color: "transparent"
    border.width: Math.max(1.5, root.iconSize * 0.08)
    border.color: root.color
  }
}
