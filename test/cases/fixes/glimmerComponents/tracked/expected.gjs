import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';

export default class Counter extends Component {
  @tracked count = 0;

  increment = () => {
    this.count++;
  };

  <template>
    <button {{on "click" this.increment}}>
      Count: {{this.count}}
    </button>
  </template>
}