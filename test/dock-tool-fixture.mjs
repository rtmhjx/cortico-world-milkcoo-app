export function dockTool(world, action) {
  const tool = world.tools().find(item => item.name === 'coodock_use');
  return {
    ...tool,
    handler: (input, call) => tool.handler({ action, argsJson: JSON.stringify(input) }, call),
  };
}
