import QtQuick
import QtQuick.Effects

// The mark: a robot holding a coin, from assets/chip.svg. The file is drawn in white ink and
// recoloured here, so one SVG serves every Omarchy theme and the shape is never redrawn in QML.
Item {
  id: root

  property color color: "white"

  Image {
    id: mark
    anchors.fill: parent
    source: Qt.resolvedUrl("assets/chip.svg")
    fillMode: Image.PreserveAspectFit
    // Rasterise well above the drawn size so the mark stays crisp on a fractionally scaled
    // display — this bar runs at 1.25.
    sourceSize.width: Math.max(64, Math.round(width * 3))
    sourceSize.height: Math.max(64, Math.round(height * 3))
    // Hidden because MultiEffect draws it again in the same place; both visible would
    // double-draw the mark.
    visible: false
    asynchronous: false
  }

  MultiEffect {
    anchors.fill: mark
    source: mark
    colorization: 1.0
    colorizationColor: root.color
  }
}
