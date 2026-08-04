import Component from '@glimmer/component';
import { on } from '@ember/modifier';
import { tracked } from '@glimmer/tracking';

export default class Counter extends Component {
  @tracked count: number;

  get displayCount() {
    if (this.count === undefined) {
      this.count = 0;
    }
    return this.count;
  }

  increment = () => {
    this.count++;
  };

  <template>
    <button {{on "click" this.increment}}>
      Count: {{this.displayCount}}
    </button>
  </template>
}