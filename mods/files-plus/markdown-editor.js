import { TYPE } from './type-scale.js';
import { div } from 'gpui-kit';
import { h_flex, v_flex, Editor, EditorState, Input, InputState, TextView } from 'gpui-base';
import { settings } from 'herdr';
import { editableMarkdownBlocks, editableTable, replaceMarkdownRange, replaceTableCell } from './markdown-edit-model.js';
import { markdownForPreview } from './preview-model.js';

export default class MarkdownEditor {
  constructor(preview) { this.preview = preview; this.active = null; this.inputs = []; this.error = ''; }
  close() { this.editor?.release(); this.editor = null; this.inputs.forEach(row => row.forEach(input => input.release())); this.inputs = []; this.active = null; }
  select(block, cx) {
    this.close(); this.error = ''; this.active = { ...block };
    const table = block.kind === 'table' && editableTable(block.text);
    if (table) this.inputs = table.map((row, r) => row.map((cell, c) => {
      const input = InputState.new({ value: cell.value });
      input.on('change', (_e, cx) => { try { this.change(replaceTableCell(this.active.text, r, c, input.value()), cx); } catch (error) { this.error = error.message; cx.notify(); } });
      return input;
    }));
    else {
      this.editor = EditorState.new({ language: 'markdown', value: block.text, readonly: false, line_numbers: false, folding: false, soft_wrap: true, font_family: settings().font_family, font_size: this.preview.fontSize });
      this.editor.on('change', (_e, cx) => this.change(this.editor.value(), cx));
    }
    cx.notify();
  }
  change(text, cx) {
    if (!this.active || !this.preview.editing) return;
    try {
      const next = replaceMarkdownRange(this.preview.code.value(), this.active, text);
      this.active = next.range; this.preview.code.set_value(next.source); this.preview.changed(cx); this.error = '';
    } catch (error) { this.error = error.message; }
    cx.notify();
  }
  render(t) {
    const source = this.preview.code.value(), active = this.active;
    const blocks = active ? [...(active.start ? editableMarkdownBlocks(source.slice(0, active.start)) : []), { ...active, active: true },
      ...(active.end < source.length ? editableMarkdownBlocks(source.slice(active.end), active.end) : [])] : editableMarkdownBlocks(source);
    const editable = blocks.filter(block => block.active || block.kind !== 'space' && (block.text || !source)), visible = editable.slice(0, 300);
    const button = (id, label, action) => div().id(id).px(7).py(3).rounded(4).text_size(TYPE.xs).cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => action(cx)).child(label);
    return v_flex().id('markdown-block-editor').flex_1().min_h(0).min_w(0).gap(6)
      .child(div().px(12).text_size(TYPE.xs).text_color(t.dim).child('Select a block to edit. Table cells accept Markdown. Save writes the document.'))
      .when(Boolean(this.error), el => el.child(div().px(12).text_color(t.blocked).child(this.error)))
      .child(v_flex().id('markdown-edit-scroll').flex_1().min_h(0).min_w(0).overflow_y_scrollbar().p(10).gap(8).pr(16).children(visible.map(block => {
        const box = v_flex().id('markdown-edit-block-' + block.start).flex_none().min_w(0).p(8).gap(5).border_1().border_color(block.active ? t.accent : t.border).rounded(5);
        box.child(h_flex().items_center().child(div().flex_1().text_size(TYPE.xs).text_color(t.dim).child(block.kind))
          .child(button('markdown-block-action-' + block.start, block.active ? 'Close block' : 'Edit', cx => { if (block.active) { this.close(); cx.notify(); } else this.select(block, cx); })));
        if (block.active && this.editor) return box.child(Editor.new(this.editor).h(Math.min(420, Math.max(100, this.active.text.split('\n').length * 22 + 40))).w_full());
        if (block.active) return box.child(v_flex().id('markdown-table-edit').overflow_x_scrollbar().gap(4).children(this.inputs.map((row, r) => h_flex().flex_none().gap(4)
          .child(div().w(42).flex_none().text_size(TYPE.xs).text_color(t.dim).child(r === 0 ? 'Head' : String(r)))
          .children(row.map(input => Input.new(input).w(170).flex_none())))));
        return box.child(TextView.markdown('markdown-edit-render-' + block.start, markdownForPreview(block.text || '*Empty document*')).selectable(true).scrollable(false).w_full().text_size(this.preview.fontSize));
      })).when(editable.length > 300, el => el.child(div().text_color(t.dim).child('Showing the first 300 blocks. Use Edit source for the whole document.'))));
  }
}
