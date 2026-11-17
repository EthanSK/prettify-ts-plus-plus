// Synthetic TSX fixture: real JSX syntax selects VS Code's typescriptreact hover provider without React dependencies.
// eslint-disable-next-line @typescript-eslint/no-namespace, @typescript-eslint/no-unused-vars -- JSX is the compiler's ambient contract for this fixture.
declare namespace JSX {
  interface IntrinsicElements {
    div: { title?: string };
  }
}

type TsxModel = { details: { value: string } };
declare const tsxModel: TsxModel;
const tsxElement = <div title={tsxModel.details.value} />;
void tsxElement;
