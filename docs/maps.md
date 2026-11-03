# Maps

A **Map** element is an image with things placed on it. The image lives in the campaign folder under `assets/maps/`; pins, routes, territories and the scale live in the map's frontmatter.

## Getting an image in

Create a Map under Places, then either press **Import image** and pick a file, or drag an image onto the map area from Explorer, Finder or a browser. PNG, JPEG, WebP and GIF work, up to 100 MB.

**Replace image** swaps the picture and keeps everything placed on it. Pins keep their pixel positions, so a replacement should be the same size.

## Moving around

- Scroll to zoom, drag to pan.
- The **Fit** dropdown chooses how the image is framed when the map opens: fit the whole image, fill the view, fit width, fit height, or actual size.
- The **lock** keeps the image inside the frame. Locked, you can still zoom, and pan only as far as the image's edges. Unlocked, there is slack around the image.

## Tools

The toolbar on the left of the map header holds the tools. One is active at a time; Escape returns to panning.

| Tool           | What it does                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pan            | Default. Click a pin, route or territory to select it.                                                                                              |
| Add pin        | Click the map to place a pin, then fill in its label and link below the map.                                                                        |
| Draw route     | Click to add points along a road, river or voyage. Enter or **Finish route** when done, then name it.                                               |
| Draw territory | Click around an area. Enter or **Finish territory** when done, then name it and say whose it is.                                                    |
| Measure        | Click two points for the straight-line distance. Switch to **Along a route** and click two points near a route for the distance travelled along it. |
| Set scale      | Click two points a known distance apart and type the distance and unit. Everything else uses this.                                                  |

## Pins

A pin marks a place or a person. Select one to edit it below the map:

- **Label** is what the map shows. Leave it empty to use the linked element's name.
- **Linked element** connects the pin to a location, a character, another map, anything. The dropdown lists locations first, then maps, then the rest. Click the pin's **Open** button, or double-click the pin, to go there.
- **Colour** and **icon**: nine colours and twenty icons such as town, castle, inn, port, danger and quest. Dot is the plain marker.
- **Shared** decides whether players see the pin when the map is shared.
- Drag a pin to move it. The bin removes it.

A pin with no link has a **New sub-map** button that creates a new map named after the pin and links the pin to it. See [Nested maps](#nested-maps).

## Routes

A route is a line with a name and a colour. Select it to rename or recolour, see its length and travel times, or delete it. The **Routes** list under the map shows every route with its length and the time at each travel pace; clicking a row zooms to it, the ruler icon measures along it.

## Territories

A territory is a filled area with a name, a colour and an owner, usually a faction or a realm. Its label sits in the middle of the area. Select it to change the name, owner or colour, see its area in square map units, or delete it. The **Territories** list under the map shows them all with their owner and area.

Double-clicking a territory linked to an element opens that element.

## Scale, distance and travel time

Set the scale once with the Set scale tool. From then on routes show their length and measurements show distance in your unit, and both show how long the journey takes at each **travel pace**.

Paces are a campaign setting: press **Paces** in the map toolbar to edit them. The defaults are on foot 24, on horseback 40 and by wagon 16 per day, with eight hours on the move. Add, rename, retune or remove paces; every map in the campaign uses the same list. Distances per day are in whatever unit your maps use.

## Nested maps

Link a pin or a territory to another Map element and that map becomes a sub-map: a city on a continent, a dungeon under a city. Double-click the pin to open it. A strip above the toolbar shows **Within** (the maps this one is pinned on) and **Maps inside** (the maps reachable from here), each a click away.

Nothing extra is stored for nesting; it is derived from the links, so removing the pin removes the relationship.

## Sharing a map

Mark the map **Shared** and players get the image. Then choose which pins, routes and territories they may see with the **Shared** checkbox on each. A pin or territory linked to a private element still shows, but without the link.
