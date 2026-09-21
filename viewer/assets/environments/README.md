# Environment textures

Put project-supplied 2:1 equirectangular `.jpg`, `.jpeg`, or `.png` files in this directory.
Register each file in `manifest.json`, for example:

```json
{
  "textures": [
    { "id": "plant-yard", "label": "Plant yard", "file": "plant-yard.jpg" }
  ]
}
```

Only the selected image is loaded. These textures are used as the scene background only;
they are not assigned to `scene.environment` and do not affect model lighting or reflections.
