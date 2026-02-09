declare module 'inquirer-autocomplete-prompt' {
  import { PromptModule } from 'inquirer';
  const plugin: Parameters<PromptModule['registerPrompt']>[1];
  export default plugin;
}
