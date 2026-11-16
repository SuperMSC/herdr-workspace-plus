import { TYPE } from './type-scale.js';
import { div, image, svg } from 'gpui-kit';
import { h_flex, v_flex, Input, InputState } from 'gpui-base';
import { agents, terminals, theme, run, closeOverlay } from 'herdr';
const LABEL = { blocked: 'Needs you', done: 'Done', working: 'Working', idle: 'Idle' };
const RANK = { blocked: 0, done: 1, working: 2, idle: 3 };

export default class LiveAgents {
  init(p, cx) {
    this.p = p; this.query = ''; this.filter = 'all'; this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: 'Filter agents and projects…' });
    this.input.on('change', (_e, cx) => { this.query = this.input.value(); cx.notify(); }); this.input.focus();
  }
  rows() {
    const live = new Map(terminals().map(t => [t.address, t])), terms = this.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return agents().filter(a => (!live.has(a.address) || live.get(a.address).state === 'live') && (this.filter === 'all' || a.status === this.filter))
      .map(a => ({ ...a, created: live.get(a.address)?.created_ms }))
      .filter(a => terms.every(term => `${a.title} ${a.space_name} ${a.program?.name} ${a.address}`.toLowerCase().includes(term)))
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (RANK[a.status] ?? 4) - (RANK[b.status] ?? 4) || b.seq - a.seq);
  }
  current(row) {
    const agent = agents().find(a => a.address === row.address), terminal = terminals().find(t => t.address === row.address);
    return agent && (!terminal || terminal.state === 'live') && terminal?.created_ms === row.created ? agent : null;
  }
  open(row) { if (!this.current(row)) return; closeOverlay(this.p.overlay); run('agent.focus', { terminal: row.address }); }
  pin(row) { const current = this.current(row); if (current) run('terminal.pin', { terminal: row.address, pinned: !current.pinned }); }
  close() { this.input?.release(); }
  render() {
    const t = theme(), rows = this.rows(), all = agents();
    const button = (id, text, active, action) => div().id(id).px(8).py(5).rounded(5).bg(active ? t.selected : t.surface).cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => action(cx)).child(text);
    let previous = null;
    return v_flex().id('live-agents-dialog').size_full().min_h(0).p(14).gap(10).bg(t.surface).text_color(t.foreground).text_size(TYPE.md)
      .track_focus(this.handle).on_key_down((e, cx) => { if (e.key === 'escape') { closeOverlay(this.p.overlay); cx.stop_propagation(); } })
      .child(div().font_semibold().text_size(TYPE.lg).child(`Agents · ${all.length}`))
      .child(Input.new(this.input).w_full())
      .child(h_flex().flex_wrap().gap(4).children(['all', 'blocked', 'done', 'working', 'idle'].map(status => button('agents-filter-' + status,
        `${status === 'all' ? 'All' : LABEL[status]} · ${status === 'all' ? all.length : all.filter(a => a.status === status).length}`, this.filter === status, cx => { this.filter = status; cx.notify(); }))))
      .child(v_flex().id('live-agents-list').flex_1().min_h(0).gap(4).overflow_y_scrollbar().pr(16).children(rows.flatMap(row => {
        const group = row.pinned ? 'Pinned' : LABEL[row.status] || row.status, elements = [];
        if (group !== previous) elements.push(div().pt(7).pb(2).text_size(TYPE.xs).text_color(t.dim).child(group)); previous = group;
        const name = row.title || row.tab_name || row.program?.name || row.address, color = t[row.status] || t.dim;
        const icon = row.program?.icon ? row.program.tint ? svg(row.program.icon).size(18) : image(row.program.icon).size(18) : null;
        elements.push(h_flex().id('live-agent-' + row.address).min_h(58).flex_none().p(9).gap(10).items_center().rounded(6).bg(row.focused ? t.selected : t.raised)
          .cursor_pointer().hover(s => s.bg(t.hover)).on_click(() => this.open(row))
          .when(Boolean(icon), el => el.child(icon.flex_none()))
          .child(v_flex().flex_1().min_w(0).gap(4).child(div().truncate().tooltip(name).child(name))
            .child(div().text_size(TYPE.sm).text_color(t.muted).truncate().child(`${row.space_name || 'No project'} · ${row.program?.name || row.app || 'Agent'} · ${row.address}`)))
          .child(div().text_size(TYPE.xs).text_color(color).child(LABEL[row.status] || row.status))
          .child(div().id('live-agent-pin-' + row.address).size(24).flex_none().flex().items_center().justify_center().rounded(4).tooltip(row.pinned ? 'Unpin agent' : 'Pin agent').hover(s => s.bg(t.selected))
            .on_click((_e, cx) => { cx.stop_propagation(); this.pin(row); }).child(svg(`mods/workspace-chrome/${row.pinned ? 'pin-off' : 'pin'}.svg`).size(13))));
        return elements;
      })).when(!rows.length, el => el.child(div().p(12).text_color(t.dim).child(all.length ? 'No matching agents.' : 'No running agents report a status yet.'))));
  }
}
